import hre from 'hardhat'
import {
  encodePacked,
  getAddress,
  keccak256,
  labelhash,
  namehash,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { signIntent } from './fixtures/namesV2.js'

// A subname counts only while its whole chain up to the 2LD is intact. These
// pin the ways a 2LD's former holder could otherwise act under the next
// holder's name: by pulling a tracked subname out of the registrar in the
// registry, by making nodes there directly, or by leaving records behind.

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const ownerAccount = ownerClient.account // stands in as BaseRegistrar
const aliceAccount = aliceClient.account
const bobAccount = bobClient.account

const TLD_NODE = namehash('testing')
const ALICE_NODE = namehash('alice.testing')
const FAR_FUTURE = 2n ** 64n
const subnode = (parent: `0x${string}`, label: string) =>
  keccak256(encodePacked(['bytes32', 'bytes32'], [parent, labelhash(label)]))

async function fixture() {
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('testing'),
    ownerAccount.address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    TLD_NODE,
    labelhash('alice'),
    aliceAccount.address,
  ])
  const subnames = await connection.viem.deployContract('SubnameRegistrar', [
    ensRegistry.address,
    ownerAccount.address,
  ])
  const resolver = await connection.viem.deployContract('SimplexResolver', [
    ensRegistry.address,
    subnames.address,
    zeroAddress,
    zeroAddress,
  ])
  await subnames.write.setResolver([resolver.address])
  await subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE], {
    account: ownerAccount,
  })
  for (const account of [aliceAccount, bobAccount]) {
    await ensRegistry.write.setApprovalForAll([subnames.address, true], {
      account,
    })
  }
  return { ensRegistry, subnames, resolver }
}

const loadFixture = async () => connection.networkHelpers.loadFixture(fixture)

type Fixture = Awaited<ReturnType<typeof fixture>>

// The NFT moves to bob; BaseRegistrar auto-reclaim re-points the 2LD node.
const transferToBob = ({ ensRegistry }: Fixture) =>
  ensRegistry.write.setSubnodeOwner([
    TLD_NODE,
    labelhash('alice'),
    bobAccount.address,
  ])

const reregisterToBob = async (f: Fixture) => {
  await f.subnames.write.onReregister([ALICE_NODE], { account: ownerAccount })
  await transferToBob(f)
}

// alice takes a tracked subname out of the registrar in the registry, which
// the registry allows the 2LD's owner to do.
const pullOut = ({ ensRegistry }: Fixture, label: string) =>
  ensRegistry.write.setSubnodeOwner(
    [ALICE_NODE, labelhash(label), aliceAccount.address],
    { account: aliceAccount },
  )

describe('SubnameRegistrar chain integrity', () => {
  it('a former holder cannot create under a subname pulled out of the registrar, after a transfer', async () => {
    const f = await loadFixture()
    await f.subnames.write.createSubname([ALICE_NODE, 'help'], {
      account: aliceAccount,
    })
    await pullOut(f, 'help')
    await transferToBob(f)

    await expect(
      f.subnames.write.createSubname([subnode(ALICE_NODE, 'help'), 'support'], {
        account: aliceAccount,
      }),
    ).rejects.toThrow('NotParentOwner')
  })

  it('nor after a re-registration, by signature either', async () => {
    const f = await loadFixture()
    await f.subnames.write.createSubname([ALICE_NODE, 'help'], {
      account: aliceAccount,
    })
    await pullOut(f, 'help')
    await reregisterToBob(f)

    const create = {
      parentNode: subnode(ALICE_NODE, 'help'),
      label: 'support',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await signIntent(
      publicClient,
      aliceClient,
      'SimplexSubnames',
      f.subnames.address,
      'CreateSubname',
      create,
    )
    await expect(
      f.subnames.write.createSubnameWithSig(
        [create.parentNode, create.label, create.nonce, create.deadline, sig],
        { account: bobAccount },
      ),
    ).rejects.toThrow('NotParentOwner')
  })

  it('a pulled-out subname and everything under it stop counting, and re-creating it does not restore the subtree', async () => {
    const f = await loadFixture()
    const help = subnode(ALICE_NODE, 'help')
    const support = subnode(help, 'support')
    await f.subnames.write.createSubname([ALICE_NODE, 'help'], {
      account: aliceAccount,
    })
    await f.subnames.write.createSubname([help, 'support'], {
      account: aliceAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(support)])).toBe(
      getAddress(aliceAccount.address),
    )

    await pullOut(f, 'help')
    await transferToBob(f)
    expect(await f.subnames.read.ownerOf([BigInt(help)])).toBe(zeroAddress)
    expect(await f.subnames.read.ownerOf([BigInt(support)])).toBe(zeroAddress)

    await f.subnames.write.createSubname([ALICE_NODE, 'help'], {
      account: bobAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(help)])).toBe(
      getAddress(bobAccount.address),
    )
    expect(await f.subnames.read.ownerOf([BigInt(support)])).toBe(zeroAddress)
  })

  it('a node made directly in the registry has no controller', async () => {
    const f = await loadFixture()
    await f.ensRegistry.write.setSubnodeOwner(
      [ALICE_NODE, labelhash('shadow'), aliceAccount.address],
      { account: aliceAccount },
    )
    await expect(
      f.subnames.write.createSubname([subnode(ALICE_NODE, 'shadow'), 'x'], {
        account: aliceAccount,
      }),
    ).rejects.toThrow('NotParentOwner')
  })

  it('re-creating a deleted middle subname does not restore its old children, and purge retires them', async () => {
    const f = await loadFixture()
    const team = subnode(ALICE_NODE, 'team')
    const support = subnode(team, 'support')
    await f.subnames.write.createSubname([ALICE_NODE, 'team'], {
      account: aliceAccount,
    })
    await f.subnames.write.createSubname([team, 'support'], {
      account: aliceAccount,
    })
    await f.resolver.write.setText([support, 'simplex.contact', 'smp://alice'], {
      account: aliceAccount,
    })
    await f.subnames.write.deleteSubname([ALICE_NODE, 'team'], {
      account: aliceAccount,
    })
    await transferToBob(f)

    await f.subnames.write.createSubname([ALICE_NODE, 'team'], {
      account: bobAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(support)])).toBe(zeroAddress)

    await f.subnames.write.purge([team, [labelhash('support')]], {
      account: bobAccount,
    })
    expect(await f.ensRegistry.read.owner([support])).toBe(zeroAddress)
    expect(await f.resolver.read.text([support, 'simplex.contact'])).toBe('')
  })

  it('creating over a node the registrar did not own clears its records', async () => {
    const f = await loadFixture()
    const support = subnode(ALICE_NODE, 'support')
    await f.ensRegistry.write.setSubnodeRecord(
      [ALICE_NODE, labelhash('support'), aliceAccount.address, f.resolver.address, 0n],
      { account: aliceAccount },
    )
    await f.resolver.write.setText([support, 'simplex.contact', 'smp://alice'], {
      account: aliceAccount,
    })
    await transferToBob(f)

    await f.subnames.write.createSubname([ALICE_NODE, 'support'], {
      account: bobAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(support)])).toBe(
      getAddress(bobAccount.address),
    )
    expect(await f.resolver.read.text([support, 'simplex.contact'])).toBe('')
  })

  it('re-running createSubname on a live subname keeps its records and children', async () => {
    const f = await loadFixture()
    const mobile = subnode(ALICE_NODE, 'mobile')
    const work = subnode(mobile, 'work')
    await f.subnames.write.createSubname([ALICE_NODE, 'mobile'], {
      account: aliceAccount,
    })
    await f.subnames.write.createSubname([mobile, 'work'], {
      account: aliceAccount,
    })
    await f.resolver.write.setText([mobile, 'simplex.contact', 'smp://alice'], {
      account: aliceAccount,
    })

    await f.subnames.write.createSubname([ALICE_NODE, 'mobile'], {
      account: aliceAccount,
    })
    expect(await f.resolver.read.text([mobile, 'simplex.contact'])).toBe(
      'smp://alice',
    )
    expect(await f.subnames.read.ownerOf([BigInt(work)])).toBe(
      getAddress(aliceAccount.address),
    )
  })

  it('purge keeps the subnames of a 2LD that has merely lapsed, so a renewal keeps them', async () => {
    const f = await loadFixture()
    const mobile = subnode(ALICE_NODE, 'mobile')
    await f.subnames.write.createSubname([ALICE_NODE, 'mobile'], {
      account: aliceAccount,
    })
    await f.subnames.write.onExpiryChanged([ALICE_NODE, 1n], {
      account: ownerAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(mobile)])).toBe(zeroAddress)

    await f.subnames.write.purge([ALICE_NODE, [labelhash('mobile')]], {
      account: bobAccount,
    })
    expect(await f.subnames.read.childIndexed([mobile])).toBe(true)

    await f.subnames.write.onExpiryChanged([ALICE_NODE, FAR_FUTURE], {
      account: ownerAccount,
    })
    expect(await f.subnames.read.ownerOf([BigInt(mobile)])).toBe(
      getAddress(aliceAccount.address),
    )
  })
})
