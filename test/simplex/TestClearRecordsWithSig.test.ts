import hre from 'hardhat'
import { keccak256, toHex } from 'viem'
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
const [ownerClient, guardianClient, registrarClient, aliceClient, bobClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

const NODE = node('giftedto')
const KEY = 'simplex.contact'

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
    account: guardian,
  })
  const reg = registration('giftedto', alice.address, {
    resolver: f.resolver.address,
  })
  await commitUnderGeneralTerms(connection, f.controller, reg, { account: alice })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const sign = (client: any, resolver: `0x${string}`, message: any) =>
  signIntent(publicClient, client, 'SimplexResolver', resolver, 'ClearRecords', message)

describe('clearRecordsWithSig', () => {
  it('pins the EIP-712 type hash', async () => {
    const { resolver } = await load()
    expect(await resolver.read.CLEAR_RECORDS_TYPEHASH()).toBe(
      keccak256(
        toHex('ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)'),
      ),
    )
  })

  it('retires every record in one call', async () => {
    const { resolver } = await load()
    // the sender leaves records behind
    await resolver.write.setText([NODE, KEY, 'sender-link'], { account: alice })
    await resolver.write.setText([NODE, 'simplex.channel', 'sender-channel'], {
      account: alice,
    })
    expect(await resolver.read.text([NODE, KEY])).toBe('sender-link')

    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )

    expect(await resolver.read.text([NODE, KEY])).toBe('')
    expect(await resolver.read.text([NODE, 'simplex.channel'])).toBe('')
    expect(await resolver.read.recordVersions([NODE])).toBe(1n)
  })

  it('is one call no matter how many records existed', async () => {
    const { resolver } = await load()
    for (let i = 0; i < 8; i++) {
      await resolver.write.setText([NODE, `key.${i}`, 'x'], { account: alice })
    }
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )
    for (let i = 0; i < 8; i++) {
      expect(await resolver.read.text([NODE, `key.${i}`])).toBe('')
    }
  })

  it('rejects a signature from anyone but the owner', async () => {
    const { resolver } = await load()
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(bobClient, resolver.address, message)
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('InvalidSignature')
  })

  it('rejects a replayed signature', async () => {
    const { resolver } = await load()
    const message = { node: NODE, nonce: 0n, deadline: FAR_FUTURE }
    const sig = await sign(aliceClient, resolver.address, message)
    await resolver.write.clearRecordsWithSig(
      [NODE, message.nonce, message.deadline, sig],
      { account: bobClient.account },
    )
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('InvalidNonce')
  })

  it('rejects an expired signature', async () => {
    const { resolver } = await load()
    const past = BigInt((await publicClient.getBlock()).timestamp) - 1n
    const message = { node: NODE, nonce: 0n, deadline: past }
    const sig = await sign(aliceClient, resolver.address, message)
    await expect(
      resolver.write.clearRecordsWithSig(
        [NODE, message.nonce, message.deadline, sig],
        { account: bobClient.account },
      ),
    ).toBeRevertedWithCustomError('SignatureExpired')
  })
})
