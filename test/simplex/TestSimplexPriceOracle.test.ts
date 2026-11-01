import hre from 'hardhat'
import { toFunctionSelector, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  registerWithCredit,
  registration,
  YEAR,
  yearPriceUSD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account

/** A dollar, in the two units in play: the list is cents, quotes are attoUSD. */
const CENTS = 100n
const USD = 10n ** 18n

const priced = (labelLength: bigint, priceCentsPerYear: bigint) => ({
  labelLength,
  priceCentsPerYear,
})

/** Base $1/yr with exceptions at 13 and 32, so the gaps show. */
const GAPPED = [priced(13n, 4n * CENTS), priced(32n, 2n * CENTS)]
/** The `.simplex` launch curve: $1 at 6+, $8 at 5, $32 at 4, $128 at 3. */
const LAUNCH = [
  priced(3n, 128n * CENTS),
  priced(4n, 32n * CENTS),
  priced(5n, 8n * CENTS),
]

const label = (len: number) => 'a'.repeat(len)

async function fixture() {
  // 1e8 pins 1 attoUSD to 1 wei, so `price` and `priceUSD` are comparable.
  const feed = await connection.viem.deployContract('DummyOracle', [100000000n])
  const oracle = await connection.viem.deployContract('SimplexPriceOracle', [
    feed.address,
    8,
    CENTS,
    GAPPED,
  ])
  return { feed, oracle }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

describe('SimplexPriceOracle', () => {
  describe('lookup and gaps', () => {
    it('prices a listed length, and every other length at the base', async () => {
      const { oracle } = await load()
      const at = async (len: number) =>
        (await oracle.read.priceUSD([label(len), 0n, YEAR])).base

      expect(await at(13)).toBe(4n * USD)
      expect(await at(32)).toBe(2n * USD)
      expect(await at(12)).toBe(USD)
      expect(await at(14)).toBe(USD)
      expect(await at(1)).toBe(USD)
      expect(await at(100)).toBe(USD)
    })

    it('reproduces the launch curve exactly', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([CENTS, LAUNCH], { account: owner })
      const at = async (len: number) =>
        (await oracle.read.priceUSD([label(len), 0n, YEAR])).base

      expect(await at(3)).toBe(128n * USD)
      expect(await at(4)).toBe(32n * USD)
      expect(await at(5)).toBe(8n * USD)
      expect(await at(6)).toBe(USD)
      expect(await at(30)).toBe(USD)
      // the base, not the cheapest listed price: what keeps a one-character
      // name unsold is the controller's minCharLength, not the oracle
      expect(await at(1)).toBe(USD)
    })

    it('counts codepoints, not bytes', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([CENTS, LAUNCH], { account: owner })
      // three emoji are twelve bytes but three characters
      expect((await oracle.read.priceUSD(['🚀🚀🚀', 0n, YEAR])).base).toBe(
        128n * USD,
      )
    })

    it('a free TLD is an empty curve with a zero base', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([0n, []], { account: owner })
      for (const len of [1, 5, 20, 64]) {
        expect((await oracle.read.priceUSD([label(len), 0n, YEAR])).base).toBe(
          0n,
        )
      }
    })

    it('reads the curve back in the shape it was set', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([CENTS, LAUNCH], { account: owner })
      const [base, exceptions] = await oracle.read.prices()
      expect(base).toBe(CENTS)
      expect(
        [...exceptions]
          .map((e: any) => [e.labelLength, e.priceUSDPerYear])
          .sort((a, b) => Number(a[0] - b[0])),
      ).toEqual(LAUNCH.map((e) => [e.labelLength, e.priceUSDPerYear]))
    })

    it('replacing the curve drops the lengths the old one listed', async () => {
      const { oracle } = await load()
      expect(await oracle.read.priceCentsPerYear([32n])).toBe(2n * CENTS)
      await oracle.write.setPrices([CENTS, [priced(5n, 8n * CENTS)]], {
        account: owner,
      })
      expect(await oracle.read.priceCentsPerYear([32n])).toBe(CENTS)
      expect((await oracle.read.priceUSD([label(32), 0n, YEAR])).base).toBe(USD)
      const [, exceptions] = await oracle.read.prices()
      expect(exceptions.length).toBe(1)
    })
  })

  describe('curve validation', () => {
    const rejects = async (
      oracle: any,
      base: bigint,
      prices: ReturnType<typeof priced>[],
      error: string,
    ) =>
      expect(
        oracle.write.setPrices([base, prices], { account: owner }),
      ).toBeRevertedWithCustomError(error)

    it('rejects a length of zero', async () => {
      const { oracle } = await load()
      await rejects(oracle, CENTS, [priced(0n, 4n * CENTS)], 'LabelLengthOutOfRange')
    })

    it('rejects a length above MAX_LABEL_LENGTH', async () => {
      const { oracle } = await load()
      expect(await oracle.read.MAX_LABEL_LENGTH()).toBe(64n)
      await rejects(
        oracle,
        USD,
        [priced(65n, 4n * CENTS)],
        'LabelLengthOutOfRange',
      )
    })

    it('rejects the same length twice', async () => {
      const { oracle } = await load()
      await rejects(
        oracle,
        USD,
        [priced(5n, 8n * CENTS), priced(5n, 4n * CENTS)],
        'DuplicateLabelLength',
      )
    })

    // zero is how a gap is recognised, so it cannot also be a price
    it('rejects a zero-priced exception', async () => {
      const { oracle } = await load()
      await rejects(oracle, CENTS, [priced(5n, 0n)], 'ZeroExceptionPrice')
    })

    it('takes the exceptions in any order', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices(
        [CENTS, [priced(5n, 8n * CENTS), priced(3n, 128n * CENTS)]],
        { account: owner },
      )
      expect(await oracle.read.priceCentsPerYear([3n])).toBe(128n * CENTS)
      expect(await oracle.read.priceCentsPerYear([5n])).toBe(8n * CENTS)
    })

    // the oracle stores the curve, it does not have opinions about it
    it('accepts a longer label costing more than a shorter one', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices(
        [CENTS, [priced(3n, 2n * CENTS), priced(9n, 40n * CENTS)]],
        { account: owner },
      )
      expect(await oracle.read.priceCentsPerYear([3n])).toBe(2n * CENTS)
      expect(await oracle.read.priceCentsPerYear([9n])).toBe(40n * CENTS)
    })

    it('accepts a base above every exception', async () => {
      const { oracle } = await load()
      await oracle.write.setPrices([9n * CENTS, [priced(5n, 8n * CENTS)]], {
        account: owner,
      })
      expect(await oracle.read.priceCentsPerYear([5n])).toBe(8n * CENTS)
      expect(await oracle.read.priceCentsPerYear([9n])).toBe(9n * CENTS)
    })
  })

  describe('duration', () => {
    it('scales exactly with whole years', async () => {
      const { oracle } = await load()
      const one = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      const three = (await oracle.read.priceUSD([label(40), 0n, 3n * YEAR]))
        .base
      expect(one).toBe(USD)
      expect(three).toBe(3n * one)
    })

    it('prorates a partial year', async () => {
      const { oracle } = await load()
      const month = 28n * DAY
      expect((await oracle.read.priceUSD([label(40), 0n, month])).base).toBe(
        (USD * month) / YEAR,
      )
    })
  })

  describe('the USD and ETH quotes', () => {
    it('quotes in attoUSD, unaffected by the ETH price', async () => {
      const { oracle, feed } = await load()
      const before = await oracle.read.priceUSD([label(40), 0n, YEAR])
      await feed.write.set([500000000n]) // ETH quintuples
      const after = await oracle.read.priceUSD([label(40), 0n, YEAR])
      expect(after.base).toBe(before.base)
    })

    it('while `price` moves inversely with it', async () => {
      const { oracle, feed } = await load()
      const before = await oracle.read.price([label(40), 0n, YEAR])
      await feed.write.set([500000000n])
      const after = await oracle.read.price([label(40), 0n, YEAR])
      expect(after.base).toBe(before.base / 5n)
    })

    it('the two agree at the pinned rate', async () => {
      const { oracle } = await load()
      const usd = await oracle.read.priceUSD([label(40), 0n, YEAR])
      const wei = await oracle.read.price([label(40), 0n, YEAR])
      expect(wei.base).toBe(usd.base)
    })
  })

  describe('the price feed', () => {
    it('refuses the zero address', async () => {
      const { oracle } = await load()
      await expect(
        oracle.write.setUsdOracle([zeroAddress, 8], { account: owner }),
      ).toBeRevertedWithCustomError('ZeroAddress')
    })

    it('refuses a feed that is already dead', async () => {
      const { oracle } = await load()
      const dead = await connection.viem.deployContract('DummyOracle', [0n])
      await expect(
        oracle.write.setUsdOracle([dead.address, 8], { account: owner }),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      const negative = await connection.viem.deployContract('DummyOracle', [
        -100000000n,
      ])
      await expect(
        oracle.write.setUsdOracle([negative.address, 8], { account: owner }),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
    })

    it('rejects a decimals value outside the plausible range', async () => {
      const { oracle, feed } = await load()
      for (const bad of [0, 37, 255]) {
        await expect(
          oracle.write.setUsdOracle([feed.address, bad], { account: owner }),
        ).toBeRevertedWithCustomError('InvalidFeedDecimals')
      }
    })

    it('converts through the stated feed scale, not a hardcoded one', async () => {
      const { oracle } = await load()
      const weiAt8 = (await oracle.read.price([label(40), 0n, YEAR])).base

      // The same real ETH price ($1) reported by an 18-decimal feed. Quoting it
      // as 8 decimals would misprice by 1e10; stating the scale keeps it exact.
      const wideFeed = await connection.viem.deployContract('DummyOracle', [
        10n ** 18n,
      ])
      await oracle.write.setUsdOracle([wideFeed.address, 18], {
        account: owner,
      })
      expect(await oracle.read.usdOracleScale()).toBe(10n ** 18n)
      expect((await oracle.read.price([label(40), 0n, YEAR])).base).toBe(weiAt8)

      // and stating it wrongly is exactly the mispricing the parameter exists
      // to make explicit, so it is visible in the transaction rather than silent
      await oracle.write.setUsdOracle([wideFeed.address, 8], { account: owner })
      expect((await oracle.read.price([label(40), 0n, YEAR])).base).toBe(
        weiAt8 / 10n ** 10n,
      )
    })

    it('swaps the feed without moving the USD list price', async () => {
      const { oracle } = await load()
      const usdBefore = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      const weiBefore = (await oracle.read.price([label(40), 0n, YEAR])).base

      const replacement = await connection.viem.deployContract('DummyOracle', [
        200000000n,
      ])
      await oracle.write.setUsdOracle([replacement.address, 8], {
        account: owner,
      })

      expect((await oracle.read.usdOracle()).toLowerCase()).toBe(
        replacement.address.toLowerCase(),
      )
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        usdBefore,
      )
      expect((await oracle.read.price([label(40), 0n, YEAR])).base).toBe(
        weiBefore / 2n,
      )
    })

    it('a feed that dies after installation stops `price` but not `priceUSD`', async () => {
      const { oracle, feed } = await load()
      const before = (await oracle.read.priceUSD([label(40), 0n, YEAR])).base
      await feed.write.set([0n])
      await expect(
        oracle.read.price([label(40), 0n, YEAR]),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        before,
      )
      await feed.write.set([-100000000n])
      await expect(
        oracle.read.price([label(40), 0n, YEAR]),
      ).toBeRevertedWithCustomError('InvalidPriceFeed')
      expect((await oracle.read.priceUSD([label(40), 0n, YEAR])).base).toBe(
        before,
      )
    })
  })

  describe('lapsed names', () => {
    it('carry no premium, however long ago they expired', async () => {
      const { oracle } = await load()
      const { timestamp } = await publicClient.getBlock()
      for (const ago of [0n, DAY, 30n * DAY, 400n * DAY]) {
        const quote = await oracle.read.priceUSD([
          label(20),
          timestamp - 90n * DAY - ago,
          YEAR,
        ])
        expect(quote.premium).toBe(0n)
        expect(quote.base).toBe(USD)
      }
    })
  })

  describe('ownership', () => {
    const OWNABLE = 'Ownable: caller is not the owner'

    it('refuses every setter to a non-owner', async () => {
      const { oracle, feed } = await load()
      await expect(
        oracle.write.setPrices([CENTS, LAUNCH], { account: alice }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        oracle.write.setUsdOracle([feed.address, 8], { account: alice }),
      ).toBeRevertedWithString(OWNABLE)
    })

    it('hands over in two steps, and the pending owner has nothing until it accepts', async () => {
      const { oracle } = await load()
      await oracle.write.transferOwnership([guardian.address], {
        account: owner,
      })
      expect((await oracle.read.pendingOwner()).toLowerCase()).toBe(
        guardian.address.toLowerCase(),
      )
      await expect(
        oracle.write.setPrices([CENTS, LAUNCH], { account: guardian }),
      ).toBeRevertedWithString(OWNABLE)

      await oracle.write.acceptOwnership({ account: guardian })
      expect((await oracle.read.owner()).toLowerCase()).toBe(
        guardian.address.toLowerCase(),
      )
      await oracle.write.setPrices([CENTS, LAUNCH], { account: guardian })
      await expect(
        oracle.write.setPrices([CENTS, LAUNCH], { account: owner }),
      ).toBeRevertedWithString(OWNABLE)
    })
  })

  it('advertises the price-oracle interfaces', async () => {
    const { oracle, feed } = await load()
    const ids = [
      '0x01ffc9a7', // IERC165
      toFunctionSelector('price(string,uint256,uint256)'), // IPriceOracle
      toFunctionSelector('priceUSD(string,uint256,uint256)'), // IPriceOracleUSD
    ] as const
    const vendored = await connection.viem.deployContract('StablePriceOracle', [
      feed.address,
      [0n, 0n, 0n, 0n, 0n],
    ])
    for (const id of ids) {
      expect(await oracle.read.supportsInterface([id])).toBe(true)
      // the same three the vendored oracle claims, which is what makes it a swap
      expect(await vendored.read.supportsInterface([id])).toBe(true)
    }
    expect(await oracle.read.supportsInterface(['0xdeadbeef'])).toBe(false)
  })

  describe('against the controller', () => {
    async function stackFixture() {
      const f = await deployNamesV2(connection, {
        owner: owner.address,
        beneficiary: guardian.address,
      })
      await f.controller.write.setPublicSalesOpen([true], { account: guardian })
      await f.sponsor.write.setRegistrarAllowance(
        [registrar.address, AMPLE_ALLOWANCE],
        { account: guardian },
      )
      return f
    }
    const loadStack = () => connection.networkHelpers.loadFixture(stackFixture)

    const register = async (controller: any, name: string, value: bigint) => {
      const reg = registration(name, alice.address)
      await commitUnderGeneralTerms(connection, controller, reg, {
        account: alice,
      })
      return controller.write.register([reg], { account: alice, value })
    }

    it('is what the fixture stack now prices with', async () => {
      const { controller, priceOracle } = await loadStack()
      expect((await controller.read.prices()).toLowerCase()).toBe(
        priceOracle.address.toLowerCase(),
      )
      expect(await controller.read.rentPrice(['sixchr', YEAR])).toHaveProperty(
        'base',
        yearPriceUSD(6),
      )
    })

    it('a curve change by call moves what the next registration pays', async () => {
      const { controller, priceOracle } = await loadStack()
      const before = (await controller.read.rentPrice(['sixchr', YEAR])).base
      await priceOracle.write.setPrices([2n * CENTS, LAUNCH], { account: owner })
      const after = (await controller.read.rentPrice(['sixchr', YEAR])).base
      expect(after).toBe(2n * USD)
      expect(after).not.toBe(before)

      await register(controller, 'sixchr', 2n * after)
      expect(await controller.read.available(['sixchr'])).toBe(false)
      // the fee actually charged is the new one, and the excess is refunded
      expect(
        await publicClient.getBalance({ address: controller.address }),
      ).toBe(2n * after)
    })

    it('the sponsored path spends the new price in attoUSD', async () => {
      const { controller, priceOracle, sponsor } = await loadStack()
      await priceOracle.write.setPrices([2n * CENTS, LAUNCH], { account: owner })
      // drop to five characters, the only length priced at $8
      await controller.write.setMinCharLength([5], { account: owner })
      const reg = registration('spons', alice.address)
      await commitUnderGeneralTerms(connection, controller, reg, { account: alice })
      await registerWithCredit(connection, sponsor, reg, { account: registrar })
      expect(
        await sponsor.read.registrarAllowance([registrar.address]),
      ).toBe(
        AMPLE_ALLOWANCE - 2n * 8n * USD, // five characters, so $8
      )
    })
  })
})
