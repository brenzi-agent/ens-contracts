import hre from 'hardhat'
import { labelhash, namehash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  acceptGeneralTermsForClaim,
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
const [ownerClient, guardianClient, registrarClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account

const PARENT = node('twoldname')
const SUB = namehash('team.twoldname.simplex')

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
    account: guardian,
  })
  const reg = registration('twoldname', alice.address, {
    resolver: f.resolver.address,
  })
  await commitUnderGeneralTerms(connection, f.controller, reg, { account: alice })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
    account: alice,
  })
  await f.subnameRegistrar.write.createSubname([PARENT, 'team'], {
    account: alice,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const signText = (client: any, resolver: `0x${string}`, message: any) =>
  signIntent(publicClient, client, 'SimplexResolver', resolver, 'SetText', message)

describe('relayed edits reach subnames', () => {
  it('resolves the signer through the registrar for a subname, and directly for a 2LD', async () => {
    const { resolver, subnameRegistrar } = await load()
    // the registry says the registrar owns the subname
    expect((await resolver.read.relayedSigner([SUB])).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )
    expect((await resolver.read.relayedSigner([PARENT])).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )
    expect(
      (await subnameRegistrar.read.ownerOf([BigInt(SUB)])).toLowerCase(),
    ).toBe(alice.address.toLowerCase())
  })

  it('the 2LD holder signs an edit for the subname and it lands', async () => {
    const { resolver } = await load()
    const message = {
      node: SUB,
      key: 'simplex.contact',
      value: 'https://smp/team',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await resolver.write.setTextWithSig(
      [
        message.node,
        message.key,
        message.value,
        message.nonce,
        message.deadline,
        await signText(aliceClient, resolver.address, message),
      ],
      { account: bob },
    )
    expect(await resolver.read.text([SUB, 'simplex.contact'])).toBe(
      'https://smp/team',
    )
  })

  it('a non-holder signature does not', async () => {
    const { resolver } = await load()
    const message = {
      node: SUB,
      key: 'simplex.contact',
      value: 'https://smp/hijack',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await expect(
      resolver.write.setTextWithSig(
        [
          message.node,
          message.key,
          message.value,
          message.nonce,
          message.deadline,
          await signText(bobClient, resolver.address, message),
        ],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('follows the 2LD when the token moves, because the subname is soulbound to it', async () => {
    const { resolver, baseRegistrar } = await load()
    await baseRegistrar.write.approve([bob.address, BigInt(labelhash('twoldname'))], {
      account: alice,
    })
    await acceptGeneralTermsForClaim(
      connection,
      baseRegistrar,
      BigInt(labelhash('twoldname')),
      alice.address,
      { account: bob },
    )
    await baseRegistrar.write.transferFrom(
      [alice.address, bob.address, BigInt(labelhash('twoldname'))],
      { account: bob },
    )
    expect((await resolver.read.relayedSigner([SUB])).toLowerCase()).toBe(
      bob.address.toLowerCase(),
    )

    // alice can no longer sign for it; bob can
    const message = {
      node: SUB,
      key: 'simplex.contact',
      value: 'https://smp/newowner',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await expect(
      resolver.write.setTextWithSig(
        [
          message.node,
          message.key,
          message.value,
          message.nonce,
          message.deadline,
          await signText(aliceClient, resolver.address, message),
        ],
        { account: bob },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')

    await resolver.write.setTextWithSig(
      [
        message.node,
        message.key,
        message.value,
        message.nonce,
        message.deadline,
        await signText(bobClient, resolver.address, message),
      ],
      { account: bob },
    )
    expect(await resolver.read.text([SUB, 'simplex.contact'])).toBe(
      'https://smp/newowner',
    )
  })

  it('clearRecordsWithSig works on a subname too', async () => {
    const { resolver } = await load()
    const set = {
      node: SUB,
      key: 'simplex.contact',
      value: 'x',
      nonce: 0n,
      deadline: FAR_FUTURE,
    }
    await resolver.write.setTextWithSig(
      [set.node, set.key, set.value, set.nonce, set.deadline,
        await signText(aliceClient, resolver.address, set)],
      { account: bob },
    )
    const clear = { node: SUB, nonce: 1n, deadline: FAR_FUTURE }
    await resolver.write.clearRecordsWithSig(
      [
        clear.node,
        clear.nonce,
        clear.deadline,
        await signIntent(
          publicClient,
          aliceClient,
          'SimplexResolver',
          resolver.address,
          'ClearRecords',
          clear,
        ),
      ],
      { account: bob },
    )
    expect(await resolver.read.text([SUB, 'simplex.contact'])).toBe('')
  })
})
