import hre from 'hardhat'
import { labelhash, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  registerWithCredit,
  registration,
  signRegistration,
  sponsorOf,
  YEAR,
  YEAR_PRICE_USD,
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
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function sponsoredRegister(controller: any, reg: any) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account: registrar,
  })
  const sponsor = await sponsorOf(connection, controller)
  return registerWithCredit(connection, sponsor, reg, { account: registrar })
}

/**
 * The registrar is bounded by money, not by a count of operations: registering a
 * name deducts that name's own list price, in attoUSD, which is the unit the
 * price list is configured in and therefore does not move with the ETH price.
 */
describe('registrar allowance', () => {
  it('deducts the name price, not a flat unit', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )

    await sponsoredRegister(controller, registration('alicename', alice.address))

    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      AMPLE_ALLOWANCE - 2n * YEAR_PRICE_USD,
    )
  })

  it('a longer term costs proportionally more', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsoredRegister(
      controller,
      registration('threeyrs', alice.address, { duration: 3n * YEAR }),
    )
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      AMPLE_ALLOWANCE - 3n * YEAR_PRICE_USD,
    )
  })

  it('deducts the right price at every priced length', async () => {
    const { controller, sponsor } = await load()
    await controller.write.setMinCharLength([3], { account: owner })
    // a three-character name alone costs a thousand times the base price
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, yearPriceUSD(3) * 4n],
      { account: guardian },
    )

    // $10 at six characters and above, then ten times more per character lost
    const names = ['alicelongname', 'sevench', 'sixchr', 'fivec', 'four', 'thr']
    let remaining = yearPriceUSD(3) * 4n
    for (const label of names) {
      await sponsoredRegister(controller, registration(label, alice.address))
      const now = await sponsor.read.registrarAllowance([registrar.address])
      expect(remaining - now).toBe(yearPriceUSD(label.length, 2n))
      remaining = now
    }

    // and the ladder is what we think it is: ten times per character lost
    expect(yearPriceUSD(13)).toBe(yearPriceUSD(6))
    expect(yearPriceUSD(5)).toBe(10n * yearPriceUSD(6))
    expect(yearPriceUSD(4)).toBe(100n * yearPriceUSD(6))
    expect(yearPriceUSD(3)).toBe(1000n * yearPriceUSD(6))
  })

  it('a six-character name is priced apart from a five-character one', async () => {
    const { controller, sponsor } = await load()
    await controller.write.setMinCharLength([5], { account: owner })
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )

    await sponsoredRegister(controller, registration('sixchr', alice.address))
    const afterSix = await sponsor.read.registrarAllowance([
      registrar.address,
    ])
    await sponsoredRegister(controller, registration('fivec', alice.address))
    const afterFive = await sponsor.read.registrarAllowance([
      registrar.address,
    ])

    expect(AMPLE_ALLOWANCE - afterSix).toBe(yearPriceUSD(6, 2n))
    expect(afterSix - afterFive).toBe(yearPriceUSD(5, 2n))
    expect(afterSix - afterFive).toBe(10n * (AMPLE_ALLOWANCE - afterSix))
  })

  it('an allowance that covers a long name does not cover a short one', async () => {
    const { controller, sponsor } = await load()
    await controller.write.setMinCharLength([3], { account: owner })
    // enough for a six-character name, nowhere near a four-character one
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, yearPriceUSD(6) * 4n],
      { account: guardian },
    )

    const short = registration('four', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([short])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, short),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomError('InsufficientAllowance')

    // the long one goes through on the same allowance
    await sponsoredRegister(controller, registration('sixchr', alice.address))
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      yearPriceUSD(6, 2n),
    )
  })

  it('a multi-year short name exhausts an allowance a two-year long name barely touches', async () => {
    const { controller, sponsor } = await load()
    await controller.write.setMinCharLength([3], { account: owner })
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, yearPriceUSD(4) * 2n],
      { account: guardian },
    )

    const threeYears = registration('four', alice.address, {
      duration: 3n * YEAR,
    })
    await controller.write.commit(
      [await controller.read.makeCommitment([threeYears])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, threeYears),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomError('InsufficientAllowance')

    await sponsoredRegister(
      controller,
      registration('four', alice.address, { duration: 2n * YEAR }),
    )
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      0n,
    )
  })

  it('the unit is USD, so a moving ETH price does not change what the allowance buys', async () => {
    const { controller, dummyOracle, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    // ETH triples against USD between the two registrations
    await sponsoredRegister(controller, registration('beforemv', alice.address))
    const firstCost =
      AMPLE_ALLOWANCE -
      (await sponsor.read.registrarAllowance([registrar.address]))

    await dummyOracle.write.set([300000000n])
    const before = await sponsor.read.registrarAllowance([registrar.address])
    await sponsoredRegister(controller, registration('aftermove', alice.address))
    const secondCost =
      before - (await sponsor.read.registrarAllowance([registrar.address]))

    expect(secondCost).toBe(firstCost)
  })

  it('refuses when the allowance cannot cover the name', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, 2n * YEAR_PRICE_USD - 1n],
      { account: guardian },
    )
    const reg = registration('tooexpensive', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomError('InsufficientAllowance')
  })

  it('refuses a registrar with no allowance at all', async () => {
    const { controller, sponsor } = await load()
    const reg = registration('noallowance', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomError('InsufficientAllowance')
  })

  it('refuses a registrar with no allowance even when the name is free', async () => {
    const { controller, sponsor, priceOracle } = await load()
    await priceOracle.write.setPrices([0n, []], { account: owner })
    const reg = registration('freename', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomError('InsufficientAllowance')
  })

  it('renewWithCredit deducts the renewal price and extends the name', async () => {
    const { controller, baseRegistrar, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsoredRegister(controller, registration('renewable', alice.address))
    const afterRegister = await sponsor.read.registrarAllowance([
      registrar.address,
    ])

    const tokenId = BigInt(labelhash('renewable'))
    const before = await baseRegistrar.read.nameExpires([tokenId])
    await sponsor.write.renewWithCredit(['renewable', YEAR, zeroHash], {
      account: registrar,
    })

    expect(await baseRegistrar.read.nameExpires([tokenId])).toBe(before + YEAR)
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      afterRegister - YEAR_PRICE_USD,
    )
  })

  it('registers for up to ten years, not a second more', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsoredRegister(
      controller,
      registration('tenyears', alice.address, { duration: 10n * YEAR }),
    )

    const tooLong = registration('elevenyrs', alice.address, {
      duration: 10n * YEAR + 1n,
    })
    await controller.write.commit(
      [await controller.read.makeCommitment([tooLong])],
      { account: registrar },
    )
    await expect(
      sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, tooLong),
        { account: registrar },
      ),
    ).toBeRevertedWithCustomErrorFrom(controller, 'DurationTooLong')
  })

  it('renews up to ten years out, not further', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsoredRegister(controller, registration('decade', alice.address))
    await sponsor.write.renewWithCredit(['decade', 8n * YEAR, zeroHash], {
      account: registrar,
    })
    await expect(
      sponsor.write.renewWithCredit(['decade', YEAR, zeroHash], {
        account: registrar,
      }),
    ).toBeRevertedWithCustomErrorFrom(controller, 'DurationTooLong')
  })

  it('the guardian can zero an allowance in one transaction', async () => {
    const { sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsor.write.setRegistrarAllowance([registrar.address, 0n], {
      account: guardian,
    })
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      0n,
    )
  })

  it('only the beneficiary may set it — not the owner, not anyone else', async () => {
    const { sponsor } = await load()
    await expect(
      sponsor.write.setRegistrarAllowance([registrar.address, 1n], {
        account: owner,
      }),
    ).toBeRevertedWithCustomError('NotBeneficiary')
    await expect(
      sponsor.write.setRegistrarAllowance([registrar.address, 1n], {
        account: alice,
      }),
    ).toBeRevertedWithCustomError('NotBeneficiary')
  })

  it('a credited registration still attaches no value to the controller', async () => {
    const { controller, sponsor } = await load()
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, AMPLE_ALLOWANCE],
      { account: guardian },
    )
    await sponsoredRegister(controller, registration('freeofeth', alice.address))
    expect(await publicClient.getBalance({ address: controller.address })).toBe(
      0n,
    )
  })

  it('the payable path is unaffected and still refunds the overpayment', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([true], { account: owner })

    const reg = registration('payforit', alice.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: alice },
    )
    const before = await publicClient.getBalance({ address: alice.address })
    const hash = await controller.write.register([reg], {
      account: alice,
      value: 3n * YEAR_PRICE_USD, // 1 attoUSD is 1 wei at the pinned feed
    })
    const receipt = await publicClient.getTransactionReceipt({ hash })
    const after = await publicClient.getBalance({ address: alice.address })
    expect(before - after).toBe(
      2n * YEAR_PRICE_USD + receipt.gasUsed * receipt.effectiveGasPrice,
    )
  })
})
