import hre from 'hardhat'
import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  node,
  registerWithCredit,
  registration,
} from './fixtures/namesV2.js'

// Round-3 lows: admin footguns and inputs that were accepted but meaningless.
const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const registrar = registrarClient.account
const owner = ownerClient.account
const guardian = guardianClient.account
const alice = aliceClient.account

const NAME = 'guarded'

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  // alice needs a name she actually owns, or the parent-owner check fires
  // before the label check we are trying to reach.
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  const reg = registration(NAME, alice.address, { resolver: f.resolver.address })
  await commitUnderGeneralTerms(connection, f.controller, reg, { account: alice })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

describe('admin guards', () => {
  it('refuses a zero minimum character length (L6)', async () => {
    const { controller } = await load()
    // The setter only ever decreases, so zero is unrecoverable: it would admit
    // the empty label permanently.
    await expect(
      controller.write.setMinCharLength([0], { account: owner }),
    ).toBeRevertedWithCustomError('MinCharLengthZero')
    // a real decrease still works
    await controller.write.setMinCharLength([5], { account: owner })
    expect(await controller.read.minCharLength()).toBe(5)
  })

  it('logs a subname hook change (L18)', async () => {
    const { baseRegistrar } = await load()
    const hash = await baseRegistrar.write.setSubnameHook([zeroAddress], {
      account: owner,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    const logs = await publicClient.getContractEvents({
      address: baseRegistrar.address,
      abi: baseRegistrar.abi,
      eventName: 'SubnameHookChanged',
    })
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect(logs[logs.length - 1].args.hook).toBe(zeroAddress)
  })

  it('refuses an empty subname label (L10)', async () => {
    const { subnameRegistrar, ens } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: alice,
    })
    // An empty label namehashes back to the parent, so the node would be
    // indexed as a child of itself.
    await expect(
      subnameRegistrar.write.createSubname([node(NAME), ''], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('EmptyLabel')
    // a real label still works
    await subnameRegistrar.write.createSubname([node(NAME), 'pay'], {
      account: alice,
    })
  })
})
