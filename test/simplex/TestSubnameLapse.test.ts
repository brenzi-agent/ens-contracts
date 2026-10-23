import hre from 'hardhat'
import {
  encodePacked,
  keccak256,
  labelhash,
  namehash,
  zeroHash,
  zeroAddress,
  getAddress,
} from 'viem'
import { describe, it, expect } from 'vitest'
import { deploySubnameRegistrar } from './fixtures/subnameRegistrar.js'

// Review fixes for the subname half of H1 (a revived subname inheriting the
// previous 2LD owner's records) and M1 (an expired 2LD keeping authority over
// its subtree, because registry ownership outlives the registration).
const connection = await hre.network.connect()
const [ownerClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
// ownerAccount stands in as the BaseRegistrar, so the tests can drive
// onReregister / onExpiryChanged directly.
const ownerAccount = ownerClient.account
const aliceAccount = aliceClient.account
const bobAccount = bobClient.account

const ALICE_NODE = namehash('alice.testing')
const PAY = subnode(ALICE_NODE, 'pay')
const KEY = 'simplex.contact'
const FAR_FUTURE = 4_000_000_000n

function subnode(parent: `0x${string}`, label: string) {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [parent, labelhash(label)]))
}

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
  // The 2LD owner approves the registrar so it may write the subnode.
  await ensRegistry.write.setApprovalForAll([subnames.address, true], {
    account: aliceAccount,
  })
  // A live registration, mirrored the way BaseRegistrar mirrors it.
  await subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE], {
    account: ownerAccount,
  })
  return { ensRegistry, subnames, resolver }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

// Alice's 2LD lapses and Bob re-registers it: the registry node moves to Bob
// and the generation bumps, exactly as BaseRegistrar drives it.
async function reregisterToBob(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ensRegistry.write.setSubnodeOwner(
    [namehash('testing'), labelhash('alice'), bobAccount.address],
    { account: ownerAccount },
  )
  await f.subnames.write.onReregister([ALICE_NODE], { account: ownerAccount })
  await f.subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE], {
    account: ownerAccount,
  })
  await f.ensRegistry.write.setApprovalForAll([f.subnames.address, true], {
    account: bobAccount,
  })
}

describe('subname lapse and revival', () => {
  it('refuses to revive a subname left behind by the previous owner', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    await reregisterToBob(f)
    // Bob owns alice.testing now, but pay.alice.testing is Alice's leftover.
    await expect(
      f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
        account: bobAccount,
      }),
    ).toBeRevertedWithCustomError('StaleSubnameMustBePurged')
  })

  it('lets the new owner take the label once it is purged, with no records carried over', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    await f.resolver.write.setText([PAY, KEY, 'https://smp/alice'], {
      account: aliceAccount,
    })
    expect(await f.resolver.read.text([PAY, KEY])).toBe('https://smp/alice')

    await reregisterToBob(f)
    // Permissionless GC, then the label is free.
    await f.subnames.write.purge([ALICE_NODE, [labelhash('pay')]], {
      account: bobAccount,
    })
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: bobAccount,
    })
    // This is the finding: without record retirement, pay.alice.testing would
    // still resolve to Alice's SimpleX address under Bob's name.
    expect(await f.resolver.read.text([PAY, KEY])).toBe('')
    expect(
      getAddress(await f.subnames.read.ownerOf([BigInt(PAY)])),
    ).toBe(getAddress(bobAccount.address))
  })

  it('retires records on an ordinary delete too', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    await f.resolver.write.setText([PAY, KEY, 'https://smp/alice'], {
      account: aliceAccount,
    })
    await f.subnames.write.deleteSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    expect(await f.resolver.read.text([PAY, KEY])).toBe('')
  })

  it('only the registrar may retire a subname record', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    await expect(
      f.resolver.write.clearSubnameRecords([PAY], { account: aliceAccount }),
    ).toBeRevertedWithCustomError('NotSubnameRegistrar')
  })

  it('a lapsed 2LD loses authority over its subtree', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    // The registration expires. Nothing clears the registry record, so without
    // the expiry mirror Alice would keep full control indefinitely.
    const now = BigInt((await (await connection.viem.getPublicClient()).getBlock()).timestamp)
    await f.subnames.write.onExpiryChanged([ALICE_NODE, now - 1n], {
      account: ownerAccount,
    })
    expect(
      await f.ensRegistry.read.owner([ALICE_NODE]),
    ).toBe(getAddress(aliceAccount.address)) // still hers in the registry
    expect(await f.subnames.read.ownerOf([BigInt(PAY)])).toBe(zeroAddress)
    await expect(
      f.subnames.write.createSubname([ALICE_NODE, 'chat'], {
        account: aliceAccount,
      }),
    ).toBeRevertedWithCustomError('NotParentOwner')
  })

  it('a renewal restores authority', async () => {
    const f = await load()
    await f.subnames.write.createSubname([ALICE_NODE, 'pay'], {
      account: aliceAccount,
    })
    const now = BigInt((await (await connection.viem.getPublicClient()).getBlock()).timestamp)
    await f.subnames.write.onExpiryChanged([ALICE_NODE, now - 1n], {
      account: ownerAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(PAY)])).toBe(zeroAddress)
    await f.subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE], {
      account: ownerAccount,
    })
    expect(
      getAddress(await f.subnames.read.ownerOf([BigInt(PAY)])),
    ).toBe(getAddress(aliceAccount.address))
  })

  it('only the base registrar may move the expiry mirror', async () => {
    const f = await load()
    await expect(
      f.subnames.write.onExpiryChanged([ALICE_NODE, 1n], {
        account: aliceAccount,
      }),
    ).toBeRevertedWithCustomError('NotBaseRegistrar')
  })
})
