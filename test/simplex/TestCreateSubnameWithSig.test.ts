import hre from 'hardhat'
import { keccak256, namehash, toHex } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  FAR_FUTURE,
  node,
  registerWithCredit,
  registration,
  signIntent,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
const [ownerClient, guardianClient, registrarClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account

const PARENT = node('alicehas')
const SUB = namehash('work.alicehas.simplex')

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
    account: guardian,
  })
  const reg = registration('alicehas', alice.address, {
    resolver: f.resolver.address,
  })
  await commitUnderGeneralTerms(connection, f.controller, reg, { account: alice })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const signSubname = (
  client: any,
  registrarAddr: `0x${string}`,
  primaryType: 'CreateSubname' | 'DeleteSubname',
  message: any,
) =>
  signIntent(
    publicClient,
    client,
    'SimplexSubnames',
    registrarAddr,
    primaryType,
    message,
  )

const signApproval = (client: any, ens: `0x${string}`, message: any) =>
  signIntent(publicClient, client, 'SimplexENSRegistry', ens, 'ApproveAll', message)

describe('createSubnameWithSig', () => {
  it('pins both EIP-712 type hashes', async () => {
    const { subnameRegistrar } = await load()
    expect(await subnameRegistrar.read.CREATE_SUBNAME_TYPEHASH()).toBe(
      keccak256(
        toHex(
          'CreateSubname(bytes32 parentNode,string label,uint256 nonce,uint256 deadline)',
        ),
      ),
    )
    expect(await subnameRegistrar.read.DELETE_SUBNAME_TYPEHASH()).toBe(
      keccak256(
        toHex(
          'DeleteSubname(bytes32 parentNode,string label,uint256 nonce,uint256 deadline)',
        ),
      ),
    )
  })

  it('a name owner with no ETH at all creates a subname end to end', async () => {
    const { ens, subnameRegistrar, resolver, controller } = await load()

    // Alice cannot send a transaction, ever, from here on.
    await testClient.setBalance({ address: alice.address, value: 0n })

    // 1. she signs the registry approval; bob relays it
    const approval = {
      owner: alice.address,
      operator: subnameRegistrar.address,
      approved: true,
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await ens.write.setApprovalForAllWithSig(
      [
        approval.owner,
        approval.operator,
        approval.approved,
        approval.nonce,
        approval.deadline,
        await signApproval(aliceClient, ens.address, approval),
      ],
      { account: bob },
    )

    // 2. she signs the creation; bob relays it
    const create = {
      parentNode: PARENT,
      label: 'work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await subnameRegistrar.write.createSubnameWithSig(
      [
        create.parentNode,
        create.label,
        create.nonce,
        create.deadline,
        await signSubname(
          aliceClient,
          subnameRegistrar.address,
          'CreateSubname',
          create,
        ),
      ],
      { account: bob },
    )

    expect((await ens.read.owner([SUB])).toLowerCase()).toBe(
      subnameRegistrar.address.toLowerCase(),
    )
    expect((await subnameRegistrar.read.ownerOf([BigInt(SUB)])).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )

    // 3. and she signs a record on it; bob relays that too
    const text = {
      node: SUB,
      key: 'simplex.contact',
      value: 'https://smp/work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await resolver.write.setTextWithSig(
      [
        text.node,
        text.key,
        text.value,
        text.nonce,
        text.deadline,
        await signIntent(
          publicClient,
          aliceClient,
          'SimplexResolver',
          resolver.address,
          'SetText',
          text,
        ),
      ],
      { account: bob },
    )
    expect(await resolver.read.text([SUB, 'simplex.contact'])).toBe(
      'https://smp/work',
    )
    expect(await publicClient.getBalance({ address: alice.address })).toBe(0n)
  })

  it('refuses creation without the registry approval', async () => {
    const { subnameRegistrar } = await load()
    const create = {
      parentNode: PARENT,
      label: 'work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await signSubname(
      aliceClient,
      subnameRegistrar.address,
      'CreateSubname',
      create,
    )
    await expect(
      subnameRegistrar.write.createSubnameWithSig(
        [create.parentNode, create.label, create.nonce, create.deadline, sig],
        { account: bob },
      ),
    ).toBeRevertedWithoutReason()
  })

  it('rejects a signature from anyone but the parent owner', async () => {
    const { ens, subnameRegistrar } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: alice,
    })
    const create = {
      parentNode: PARENT,
      label: 'work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await signSubname(
      bobClient,
      subnameRegistrar.address,
      'CreateSubname',
      create,
    )
    await expect(
      subnameRegistrar.write.createSubnameWithSig(
        [create.parentNode, create.label, create.nonce, create.deadline, sig],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('rejects a replayed signature and an expired one', async () => {
    const { ens, subnameRegistrar } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: alice,
    })
    const create = {
      parentNode: PARENT,
      label: 'work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    const sig = await signSubname(
      aliceClient,
      subnameRegistrar.address,
      'CreateSubname',
      create,
    )
    const args = [
      create.parentNode,
      create.label,
      create.nonce,
      create.deadline,
      sig,
    ] as const
    await subnameRegistrar.write.createSubnameWithSig(args, { account: bob })
    await expect(
      subnameRegistrar.write.createSubnameWithSig(args, { account: bob }),
    ).toBeRevertedWithCustomError('InvalidNonce')

    const past = BigInt((await publicClient.getBlock()).timestamp) - 1n
    const stale = {
      parentNode: PARENT,
      label: 'other',
      nonce: 1n,
      deadline: past,
    }
    await expect(
      subnameRegistrar.write.createSubnameWithSig(
        [
          stale.parentNode,
          stale.label,
          stale.nonce,
          stale.deadline,
          await signSubname(
            aliceClient,
            subnameRegistrar.address,
            'CreateSubname',
            stale,
          ),
        ],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('SignatureExpired')
  })

  it('deletes a subname on a signature too', async () => {
    const { ens, subnameRegistrar } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: alice,
    })
    await subnameRegistrar.write.createSubname([PARENT, 'work'], {
      account: alice,
    })
    expect((await ens.read.owner([SUB])).toLowerCase()).toBe(
      subnameRegistrar.address.toLowerCase(),
    )

    const del = {
      parentNode: PARENT,
      label: 'work',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await subnameRegistrar.write.deleteSubnameWithSig(
      [
        del.parentNode,
        del.label,
        del.nonce,
        del.deadline,
        await signSubname(
          aliceClient,
          subnameRegistrar.address,
          'DeleteSubname',
          del,
        ),
      ],
      { account: bob },
    )
    expect(BigInt(await ens.read.owner([SUB]))).toBe(0n)
  })

  it('the unsigned path is unchanged and still refuses a non-owner', async () => {
    const { ens, subnameRegistrar } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: alice,
    })
    await expect(
      subnameRegistrar.write.createSubname([PARENT, 'work'], { account: bob }),
    ).toBeRevertedWithCustomError('NotParentOwner')
    await subnameRegistrar.write.createSubname([PARENT, 'work'], {
      account: alice,
    })
  })
})
