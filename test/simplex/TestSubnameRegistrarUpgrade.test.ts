import hre from 'hardhat'
import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  labelhash,
  namehash,
  pad,
  sliceHex,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { FAR_FUTURE, signIntent } from './fixtures/namesV2.js'
import { deploySubnameRegistrar } from './fixtures/subnameRegistrar.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const ownerAccount = ownerClient.account // deployer, proxy owner, and stand-in BaseRegistrar
const aliceAccount = aliceClient.account
const bobAccount = bobClient.account

const ALICE_NODE = namehash('alice.testing')
const BOB_NODE = namehash('bob.testing')
const subnode = (parent: `0x${string}`, label: string) =>
  keccak256(encodePacked(['bytes32', 'bytes32'], [parent, labelhash(label)]))
const MOBILE = subnode(ALICE_NODE, 'mobile')
const WORK = subnode(MOBILE, 'work')

/** ERC-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1). */
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

async function fixture() {
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('testing'),
    ownerAccount.address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    namehash('testing'),
    labelhash('alice'),
    aliceAccount.address,
  ])
  const subnames = await deploySubnameRegistrar(
    connection.viem,
    ensRegistry.address,
    ownerAccount.address,
  )
  const resolver = await connection.viem.deployContract('SimplexResolver', [
    ensRegistry.address,
    subnames.address,
    zeroAddress,
    zeroAddress,
  ])
  await subnames.write.setResolver([resolver.address])
  await subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE])
  await ensRegistry.write.setApprovalForAll([subnames.address, true], {
    account: aliceAccount,
  })
  await subnames.write.createSubname([ALICE_NODE, 'mobile'], {
    account: aliceAccount,
  })
  await subnames.write.createSubname([MOBILE, 'work'], {
    account: aliceAccount,
  })
  await resolver.write.setText([MOBILE, 'simplex.contact', 'contact-1'], {
    account: aliceAccount,
  })
  return { ensRegistry, subnames, resolver }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const implementationOf = async (proxy: `0x${string}`) =>
  getAddress(
    sliceHex(
      (await publicClient.getStorageAt({
        address: proxy,
        slot: IMPLEMENTATION_SLOT,
      }))!,
      12,
    ),
  )

async function upgradeToV2(subnames: { address: `0x${string}` }) {
  const v2 = await connection.viem.deployContract('SubnameRegistrarV2Mock', [])
  const proxy = await connection.viem.getContractAt(
    'SubnameRegistrarV2Mock',
    subnames.address,
  )
  await proxy.write.upgradeTo([v2.address])
  return { v2, proxy }
}

describe('SubnameRegistrar UUPS upgradeability', () => {
  it('the implementation cannot be initialized directly', async () => {
    const { ensRegistry, subnames } = await load()
    const implementation = await connection.viem.getContractAt(
      'SubnameRegistrar',
      await implementationOf(subnames.address),
    )
    await expect(
      implementation.write.initialize(
        [ensRegistry.address, ownerAccount.address, bobAccount.address],
        { account: bobAccount },
      ),
    ).rejects.toThrow('Initializable: contract is already initialized')
  })

  it('the proxy cannot be initialized twice', async () => {
    const { ensRegistry, subnames } = await load()
    await expect(
      subnames.write.initialize(
        [ensRegistry.address, bobAccount.address, bobAccount.address],
        { account: bobAccount },
      ),
    ).rejects.toThrow('Initializable: contract is already initialized')
  })

  it('initialize sets the registry, the BaseRegistrar and the owner', async () => {
    const { ensRegistry, subnames } = await load()
    expect(await subnames.read.ens()).toBe(getAddress(ensRegistry.address))
    expect(await subnames.read.baseRegistrar()).toBe(
      getAddress(ownerAccount.address),
    )
    expect(await subnames.read.owner()).toBe(getAddress(ownerAccount.address))
    expect(await subnames.read.frozen()).toBe(false)
  })

  it('a non-owner cannot upgrade', async () => {
    const { subnames } = await load()
    const v2 = await connection.viem.deployContract(
      'SubnameRegistrarV2Mock',
      [],
    )
    await expect(
      subnames.write.upgradeTo([v2.address], { account: aliceAccount }),
    ).rejects.toThrow('Ownable: caller is not the owner')
  })

  it('an upgrade keeps subnames, records, generations, expiries and nonces', async () => {
    const { ensRegistry, subnames, resolver } = await load()
    await subnames.write.onReregister([BOB_NODE])
    // Signed before the upgrade, submitted after: the EIP-712 domain is the
    // proxy's, and the signer's nonce lives in its storage.
    const signedBefore = await signIntent(
      publicClient,
      aliceClient,
      'SimplexSubnames',
      subnames.address,
      'CreateSubname',
      {
        parentNode: ALICE_NODE,
        label: 'signed',
        nonce: 0n,
        deadline: FAR_FUTURE,
      },
    )
    const read = async () => ({
      mobileOwner: await subnames.read.ownerOf([BigInt(MOBILE)]),
      workOwner: await subnames.read.ownerOf([BigInt(WORK)]),
      parentOfWork: await subnames.read.parentOf([WORK]),
      children: await subnames.read.getChildren([ALICE_NODE, 0n, 10n]),
      bobGeneration: await subnames.read.generation([BOB_NODE]),
      aliceExpiry: await subnames.read.expiryOf([ALICE_NODE]),
      resolver: await subnames.read.resolver(),
      nonce: await subnames.read.nonces([aliceAccount.address]),
      domain: await subnames.read.DOMAIN_SEPARATOR(),
      owner: await subnames.read.owner(),
    })
    const before = await read()

    const { v2, proxy } = await upgradeToV2(subnames)

    expect(await implementationOf(subnames.address)).toBe(
      getAddress(v2.address),
    )
    expect(await proxy.read.version()).toBe(2n)
    expect(await read()).toEqual(before)
    expect(before.mobileOwner).toBe(getAddress(aliceAccount.address))
    expect(before.workOwner).toBe(getAddress(aliceAccount.address))
    expect(before.bobGeneration).toBe(1n)

    // The resolver still authorises subname records through the proxy.
    expect(await resolver.read.text([MOBILE, 'simplex.contact'])).toBe(
      'contact-1',
    )
    await resolver.write.setText([MOBILE, 'simplex.contact', 'contact-2'], {
      account: aliceAccount,
    })
    expect(await resolver.read.text([MOBILE, 'simplex.contact'])).toBe(
      'contact-2',
    )
    await expect(
      resolver.write.setText([MOBILE, 'simplex.contact', 'stolen'], {
        account: bobAccount,
      }),
    ).rejects.toThrow()

    // Create, signed create, and delete all keep working.
    await subnames.write.createSubnameWithSig(
      [ALICE_NODE, 'signed', 0n, FAR_FUTURE, signedBefore],
      { account: bobAccount },
    )
    expect(
      await subnames.read.ownerOf([BigInt(subnode(ALICE_NODE, 'signed'))]),
    ).toBe(getAddress(aliceAccount.address))
    expect(await subnames.read.nonces([aliceAccount.address])).toBe(1n)
    await subnames.write.deleteSubname([ALICE_NODE, 'mobile'], {
      account: aliceAccount,
    })
    expect(await ensRegistry.read.owner([MOBILE])).toBe(zeroAddress)
    expect(await resolver.read.text([MOBILE, 'simplex.contact'])).toBe('')
  })

  it('freeze stops upgrades for good', async () => {
    const { subnames } = await load()
    await expect(
      subnames.write.freeze({ account: aliceAccount }),
    ).rejects.toThrow('Ownable: caller is not the owner')

    await subnames.write.freeze()
    expect(await subnames.read.frozen()).toBe(true)
    const events = await subnames.getEvents.ContractFrozen()
    expect(events).toHaveLength(1)

    const v2 = await connection.viem.deployContract(
      'SubnameRegistrarV2Mock',
      [],
    )
    await expect(subnames.write.upgradeTo([v2.address])).rejects.toThrow(
      'Frozen',
    )
    await expect(subnames.write.freeze()).rejects.toThrow('AlreadyFrozen')
  })

  it('ownership moves in two steps, and the new owner can upgrade', async () => {
    const { subnames } = await load()
    await subnames.write.transferOwnership([bobAccount.address])
    expect(await subnames.read.owner()).toBe(getAddress(ownerAccount.address))
    expect(await subnames.read.pendingOwner()).toBe(
      getAddress(bobAccount.address),
    )
    await subnames.write.acceptOwnership({ account: bobAccount })
    expect(await subnames.read.owner()).toBe(getAddress(bobAccount.address))

    const v2 = await connection.viem.deployContract(
      'SubnameRegistrarV2Mock',
      [],
    )
    await expect(subnames.write.upgradeTo([v2.address])).rejects.toThrow(
      'Ownable: caller is not the owner',
    )
    await subnames.write.upgradeTo([v2.address], { account: bobAccount })
    expect(await implementationOf(subnames.address)).toBe(
      getAddress(v2.address),
    )
  })
})

const slotAt = (address: `0x${string}`, slot: bigint | `0x${string}`) =>
  publicClient.getStorageAt({
    address,
    slot: typeof slot === 'bigint' ? pad(toHex(slot)) : slot,
  })
const mappingSlot = (type: 'bytes32' | 'address', key: string, slot: bigint) =>
  keccak256(
    encodeAbiParameters([{ type }, { type: 'uint256' }], [key, slot] as never),
  )

/**
 * The registrar's own state, in declaration order, after the OpenZeppelin
 * upgradeable bases. An upgrade must leave every one of these where it is.
 */
describe('SubnameRegistrar storage layout', () => {
  it('keeps its thirteen slots in declaration order', async () => {
    const { ensRegistry, subnames, resolver } = await load()
    // bob.testing, re-registered once, with a subname created at generation 1
    await ensRegistry.write.setSubnodeOwner([
      namehash('testing'),
      labelhash('bob'),
      bobAccount.address,
    ])
    await subnames.write.onExpiryChanged([BOB_NODE, FAR_FUTURE])
    await subnames.write.onReregister([BOB_NODE])
    await ensRegistry.write.setApprovalForAll([subnames.address, true], {
      account: bobAccount,
    })
    await subnames.write.createSubname([BOB_NODE, 'x'], { account: bobAccount })
    const signature = await signIntent(
      publicClient,
      aliceClient,
      'SimplexSubnames',
      subnames.address,
      'CreateSubname',
      {
        parentNode: ALICE_NODE,
        label: 'signed',
        nonce: 0n,
        deadline: FAR_FUTURE,
      },
    )
    await subnames.write.createSubnameWithSig(
      [ALICE_NODE, 'signed', 0n, FAR_FUTURE, signature],
      { account: bobAccount },
    )
    await subnames.write.freeze()

    // `ens` is the first own variable; find it past the OZ bases' gaps.
    let base = -1n
    for (let i = 0n; i < 400n && base < 0n; i++) {
      if ((await slotAt(subnames.address, i)) === pad(ensRegistry.address))
        base = i
    }
    expect(base).toBeGreaterThan(200n)
    const word = (value: bigint | `0x${string}`) =>
      pad(typeof value === 'bigint' ? toHex(value) : value)

    expect(await slotAt(subnames.address, base + 1n)).toBe(
      word(ownerAccount.address), // baseRegistrar
    )
    expect(await slotAt(subnames.address, base + 2n)).toBe(
      word(resolver.address), // resolver
    )
    expect(await slotAt(subnames.address, base + 3n)).toBe(
      word(ownerAccount.address), // _deployer
    )
    const at = (type: 'bytes32' | 'address', key: string, offset: bigint) =>
      slotAt(subnames.address, mappingSlot(type, key, base + offset))
    expect(await at('bytes32', MOBILE, 4n)).toBe(ALICE_NODE) // parentOf
    expect(await at('bytes32', subnode(BOB_NODE, 'x'), 5n)).toBe(word(1n)) // generationAt
    expect(await at('bytes32', BOB_NODE, 6n)).toBe(word(1n)) // generation
    expect(await at('bytes32', ALICE_NODE, 7n)).toBe(word(FAR_FUTURE)) // expiryOf
    expect(await at('bytes32', labelhash('mobile'), 8n)).toBe(
      // labelOf: a short string stores its bytes left-aligned and 2 * length last
      pad(toHex('mobile'), { dir: 'right' }).slice(0, -2) + '0c',
    )
    expect(await at('bytes32', MOBILE, 9n)).toBe(word(1n)) // childIndexed
    expect(await at('bytes32', ALICE_NODE, 10n)).toBe(word(2n)) // _children length
    expect(await at('address', aliceAccount.address, 11n)).toBe(word(1n)) // nonces
    expect(await slotAt(subnames.address, base + 12n)).toBe(word(1n)) // frozen
  })
})
