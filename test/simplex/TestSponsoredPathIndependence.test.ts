import hre from 'hardhat'
import { labelhash, parseEventLogs, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  registration,
  YEAR,
  yearPriceUSD,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.controller.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function sponsoredRegister(controller: any, label: string) {
  const reg = registration(label, alice.address)
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account: registrar,
  })
  return controller.write.registerWithCredit([reg], { account: registrar })
}

/**
 * The app-store flow must survive a failed ETH/USD feed. The allowance is
 * denominated in attoUSD and `priceUSD` never touches the feed, so the only
 * thing that coupled the sponsored path to Chainlink was reading a wei price to
 * put in an event. It no longer does.
 */
describe('the sponsored path does not depend on the price feed', () => {
  it('registers and renews with the feed reporting zero', async () => {
    const { controller, baseRegistrar, dummyOracle } = await load()
    await dummyOracle.write.set([0n])

    await sponsoredRegister(controller, 'deadfeed')
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('deadfeed'))])
      ).toLowerCase(),
    ).toBe(alice.address.toLowerCase())

    const tokenId = BigInt(labelhash('deadfeed'))
    const before = await baseRegistrar.read.nameExpires([tokenId])
    await controller.write.renewWithCredit(['deadfeed', YEAR, zeroHash], {
      account: registrar,
    })
    expect(await baseRegistrar.read.nameExpires([tokenId])).toBe(before + YEAR)
  })

  it('still deducts the correct price in attoUSD while the feed is dead', async () => {
    const { controller, dummyOracle } = await load()
    await dummyOracle.write.set([0n])
    const before = await controller.read.registrarAllowance([registrar.address])
    await sponsoredRegister(controller, 'stillpriced')
    expect(
      before - (await controller.read.registrarAllowance([registrar.address])),
    ).toBe(yearPriceUSD(11, 2n))
  })

  it('the payable path does fail on a dead feed, loudly', async () => {
    const { controller, dummyOracle } = await load()
    await dummyOracle.write.set([0n])
    const reg = registration('payablefeed', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: alice },
    )
    // the error is declared on StablePriceOracle, so it is not in the
    // controller's ABI for the matcher to name — assert the revert bubbles up
    await expect(
      controller.write.register([reg], { account: alice, value: 10n ** 21n }),
    ).rejects.toThrow()
  })

  it('credited registration emits a zero cost — nothing was paid on-chain', async () => {
    const { controller } = await load()
    const hash = await sponsoredRegister(controller, 'zerocost')
    const receipt = await publicClient.getTransactionReceipt({ hash })

    const registered = parseEventLogs({
      abi: controller.abi,
      eventName: 'NameRegistered',
      logs: receipt.logs,
    })
    expect(registered[0].args.baseCost).toBe(0n)
    expect(registered[0].args.premium).toBe(0n)

    // and the truth of what was consumed is in the allowance event, in attoUSD
    const spent = parseEventLogs({
      abi: controller.abi,
      eventName: 'RegistrarAllowanceSpent',
      logs: receipt.logs,
    })
    expect(spent[0].args.spentUSD).toBe(yearPriceUSD(8, 2n))
  })

  it('credited renewal emits a zero cost too', async () => {
    const { controller } = await load()
    await sponsoredRegister(controller, 'renewevent')
    const hash = await controller.write.renewWithCredit(
      ['renewevent', YEAR, zeroHash],
      { account: registrar },
    )
    const receipt = await publicClient.getTransactionReceipt({ hash })
    const renewed = parseEventLogs({
      abi: controller.abi,
      eventName: 'NameRenewed',
      logs: receipt.logs,
    })
    expect(renewed[0].args.cost).toBe(0n)
  })

  it('the payable path still reports a real wei cost', async () => {
    const { controller } = await load()
    const reg = registration('paidcost', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: alice },
    )
    const hash = await controller.write.register([reg], {
      account: alice,
      value: 3n * yearPriceUSD(8),
    })
    const receipt = await publicClient.getTransactionReceipt({ hash })
    const registered = parseEventLogs({
      abi: controller.abi,
      eventName: 'NameRegistered',
      logs: receipt.logs,
    })
    expect(registered[0].args.baseCost).toBeGreaterThan(0n)
  })
})
