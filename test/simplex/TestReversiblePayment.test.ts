import { readFile } from 'node:fs/promises'
import hre from 'hardhat'
import {
  concat,
  encodeFunctionData,
  getAddress,
  keccak256,
  labelhash,
  pad,
  parseEventLogs,
  toFunctionSelector,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  acceptGeneralTermsForClaim,
  acceptGeneralTermsForRenewal,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  COMMUNITY_TERMS,
  COMMUNITY_TERMS_LINK,
  deployNamesV2,
  deploySettlement,
  FAR_FUTURE,
  GENERAL_TERMS_LINK,
  MIN_REGISTRATION,
  node,
  NOT_REVERSIBLE,
  Reason,
  registration,
  signIntent,
  signRegistration,
  signRenewal,
  YEAR,
  YEAR_PRICE_USD,
  yearPriceUSD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const DAYS = 180n
const WINDOW = 30n * DAY
const GRACE = 90n * DAY
const EXACT = { gas: 5_000_000n }

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
const [
  ownerClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
  carolClient,
] = await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
const carol = carolClient.account
type Account = typeof alice

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)
type Fixture = Awaited<ReturnType<typeof fixture>>

const id = (label: string) => BigInt(labelhash(label))

const artifact = async (commit: string, name: string) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/builds/${commit}/${name}.json`, import.meta.url),
      'utf8',
    ),
  )

async function timeOf(hash: `0x${string}`) {
  const { blockNumber } = await publicClient.waitForTransactionReceipt({ hash })
  return (await publicClient.getBlock({ blockNumber })).timestamp
}

const exactly = (timestamp: bigint) =>
  testClient.setNextBlockTimestamp({ timestamp })

async function mineAt(timestamp: bigint) {
  await exactly(timestamp)
  await testClient.mine({ blocks: 1 })
}

async function logsOf(contract: any, hash: `0x${string}`, eventName: string) {
  const { logs } = await publicClient.waitForTransactionReceipt({ hash })
  return parseEventLogs({ abi: contract.abi, eventName, logs })
    .filter((log) => getAddress(log.address) === getAddress(contract.address))
    .map((log) => log.args)
}

async function register(
  f: Fixture,
  label: string,
  {
    holder = alice,
    days = DAYS,
    duration = MIN_REGISTRATION,
    resolver = zeroAddress,
  }: Partial<{
    holder: Account
    days: bigint
    duration: bigint
    resolver: `0x${string}`
  }> = {},
) {
  const reg = registration(label, holder.address, { duration, resolver })
  await commitUnderGeneralTerms(connection, f.controller, reg, {
    account: holder,
  })
  const hash = await f.sponsor.write.registerWithCredit(
    await signRegistration(connection, f.sponsor, reg, {
      reversibleDays: days,
    }),
    { account: registrar },
  )
  const time = await timeOf(hash)
  const until = time + days * DAY
  return { hash, until, E: until + WINDOW, paid: time + duration }
}

const acceptRenewal = (
  f: Fixture,
  label: string,
  holder: Account = alice,
  duration = YEAR,
) =>
  acceptGeneralTermsForRenewal(connection, f.controller, label, duration, {
    account: holder,
  })

const payRenewal = (f: Fixture, label: string, holder: Account = alice) =>
  f.controller.write.renew([label, YEAR, zeroHash], {
    account: holder,
    value: YEAR_PRICE_USD,
  })

const creditRenewal = (f: Fixture, label: string, holder: Account = alice) =>
  f.sponsor.write.renewWithCredit(
    [label, YEAR, zeroHash, holder.address, ...NOT_REVERSIBLE],
    { account: registrar },
  )

async function renew(
  f: Fixture,
  label: string,
  { holder = alice, days = DAYS }: Partial<{ holder: Account; days: bigint }> = {},
) {
  await acceptRenewal(f, label, holder)
  const previous = await f.baseRegistrar.read.nameExpires([id(label)])
  const hash = await f.sponsor.write.renewWithCredit(
    await signRenewal(connection, f.sponsor, label, YEAR, holder.address, days),
    { account: registrar },
  )
  const until = (await timeOf(hash)) + days * DAY
  const E = until + WINDOW > previous ? until + WINDOW : previous
  return { hash, until, E, paid: previous + YEAR }
}

async function offer(
  f: Fixture,
  label: string,
  from: Account = alice,
  to: Account = bob,
) {
  await f.baseRegistrar.write.approve([to.address, id(label)], { account: from })
  await acceptGeneralTermsForClaim(
    connection,
    f.baseRegistrar,
    id(label),
    from.address,
    { account: to },
  )
}

const claim = (
  f: Fixture,
  label: string,
  from: Account = alice,
  to: Account = bob,
) =>
  f.baseRegistrar.write.transferFrom([from.address, to.address, id(label)], {
    account: to,
  })

const reverse = (
  f: Fixture,
  labels: string[],
  account: Account = guardian,
  options = {},
) => f.settlement.write.reversePayments([labels], { account, ...options })

const reinstate = (
  f: Fixture,
  labels: string[],
  account: Account = owner,
  options = {},
) => f.settlement.write.reinstatePayments([labels], { account, ...options })

const settle = (f: Fixture, label: string, options = {}) =>
  f.settlement.write.settle([label], { account: carol, ...options })

const payment = (f: Fixture, label: string) =>
  f.settlement.read.reversiblePayment([id(label)])

const expires = (f: Fixture, label: string) =>
  f.baseRegistrar.read.nameExpires([id(label)])

async function asController(f: Fixture) {
  await testClient.impersonateAccount({ address: f.controller.address })
  await testClient.setBalance({ address: f.controller.address, value: 10n ** 18n })
}

async function withSubname(f: Fixture, label: string) {
  await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
    account: alice,
  })
  await f.subnameRegistrar.write.createSubname([node(label), 'pay'], {
    account: alice,
  })
  return BigInt(keccak256(concat([node(label), labelhash('pay')])))
}

const NONE = [0n, 0n, false, false]

describe('reversible payments', () => {
  describe('registration', () => {
    it('ends the first term 30 days after reversibleUntil, on the bare and the resolver path', async () => {
      const f = await load()
      for (const [label, resolver] of [
        ['barepath', zeroAddress],
        ['resolverpath', f.resolver.address],
      ] as const) {
        const r = await register(f, label, { resolver })
        expect(await expires(f, label)).toBe(r.E)
        expect(await f.baseRegistrar.read.ownerOf([id(label)])).toBe(
          getAddress(alice.address),
        )
        expect(await logsOf(f.controller, r.hash, 'NameRegistered')).toMatchObject([
          { label, expires: r.E },
        ])
        expect(
          await logsOf(f.settlement, r.hash, 'NamePaymentReversible'),
        ).toEqual([
          {
            labelhash: labelhash(label),
            reversibleUntil: r.until,
            paidExpires: r.paid,
            renewal: false,
          },
        ])
        expect(await payment(f, label)).toEqual([r.until, r.paid, false, false])
      }
    })

    it('starts unreversed over a lapsed reversed entry', async () => {
      const f = await load()
      const first = await register(f, 'staleentry')
      await reverse(f, ['staleentry'])
      await mineAt(first.E + GRACE + 1n)
      const second = await register(f, 'staleentry', { holder: bob })
      expect(await payment(f, 'staleentry')).toEqual([
        second.until,
        second.paid,
        false,
        false,
      ])
      await offer(f, 'staleentry', bob, carol)
      await claim(f, 'staleentry', bob, carol)
    })

    it('registers the whole term with 0 days, and opens no entry', async () => {
      const f = await load()
      const r = await register(f, 'finalname', { days: 0n })
      expect(await expires(f, 'finalname')).toBe(r.paid)
      expect(
        await logsOf(f.settlement, r.hash, 'NamePaymentReversible'),
      ).toEqual([])
      expect(await payment(f, 'finalname')).toEqual(NONE)
    })

    it('takes 180 days and reverts ReversibleDaysTooMany for 181', async () => {
      const f = await load()
      expect(await f.settlement.read.MAX_REVERSIBLE_DAYS()).toBe(DAYS)
      await register(f, 'maxdaysname', { days: DAYS })
      const reg = registration('toomanydays', alice.address)
      await commitUnderGeneralTerms(connection, f.controller, reg, {
        account: alice,
      })
      await expect(
        f.sponsor.write.registerWithCredit(
          await signRegistration(connection, f.sponsor, reg, {
            reversibleDays: DAYS + 1n,
          }),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(f.settlement, 'ReversibleDaysTooMany')
    })

    it('opens an entry only for a duration above the first term', async () => {
      const f = await load()
      await asController(f)
      const firstTerm = DAYS * DAY + WINDOW
      await expect(
        f.settlement.write.open([id('shortterm'), DAYS, firstTerm, false], {
          account: f.controller.address,
        }),
      ).toBeRevertedWithCustomError('DurationTooShort')
      await f.settlement.write.open([id('shortterm'), DAYS, firstTerm + 1n, false], {
        account: f.controller.address,
      })
    })

    it('opens an entry for the controller only, and only through the proxy', async () => {
      const f = await load()
      for (const account of [owner, guardian, registrar, alice])
        await expect(
          f.settlement.write.open([id('anyname'), DAYS, MIN_REGISTRATION, false], {
            account,
          }),
        ).toBeRevertedWithCustomError('NotController')
      await asController(f)
      await expect(
        f.settlementImplementation.write.open(
          [id('anyname'), DAYS, MIN_REGISTRATION, false],
          { account: f.controller.address },
        ),
      ).toBeRevertedWithCustomError('NotProxy')
    })

    it('spends the allowance for the whole duration', async () => {
      const f = await load()
      const before = await f.sponsor.read.registrarAllowance([registrar.address])
      await register(f, 'pricedname')
      expect(
        before - (await f.sponsor.read.registrarAllowance([registrar.address])),
      ).toBe(yearPriceUSD('pricedname'.length, 2n))
    })

    it('reverts InvalidSignature for other reversible days than RegisterName names', async () => {
      const f = await load()
      const reg = registration('signeddays', alice.address)
      await commitUnderGeneralTerms(connection, f.controller, reg, {
        account: alice,
      })
      const [, , nonce, deadline, sig] = await signRegistration(
        connection,
        f.sponsor,
        reg,
        { reversibleDays: DAYS },
      )
      for (const days of [0n, DAYS - 1n])
        await expect(
          f.sponsor.write.registerWithCredit([reg, days, nonce, deadline, sig], {
            account: registrar,
          }),
        ).toBeRevertedWithCustomError('InvalidSignature')
      await f.sponsor.write.registerWithCredit([reg, DAYS, nonce, deadline, sig], {
        account: registrar,
      })
    })

    it('registers a community name with reversible days', async () => {
      const f = await load()
      await f.namePolicy.write.addCommunityNames([['community']], {
        account: guardian,
      })
      const reg = registration('community', alice.address)
      await f.namePolicy.write.commitUnderCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), COMMUNITY_TERMS],
        { account: alice },
      )
      const hash = await f.sponsor.write.registerWithCredit(
        await signRegistration(connection, f.sponsor, reg, {
          reversibleDays: DAYS,
        }),
        { account: registrar },
      )
      const until = (await timeOf(hash)) + DAYS * DAY
      expect(await expires(f, 'community')).toBe(until + WINDOW)
      await mineAt(until)
      await settle(f, 'community')
      expect(await expires(f, 'community')).toBe(
        until - DAYS * DAY + MIN_REGISTRATION,
      )
    })
  })

  describe('renewal with reversible days', () => {
    it('extends an earlier expiry to E, and renews a later one by 0', async () => {
      const f = await load()
      const near = await register(f, 'nearexpiry', { days: 0n })
      const far = await register(f, 'farexpiry', { days: 0n, duration: 3n * YEAR })
      await mineAt(near.paid - 60n * DAY)
      for (const [label, previous] of [
        ['nearexpiry', near.paid],
        ['farexpiry', far.paid],
      ] as const) {
        const r = await renew(f, label)
        expect(r.E).toBe(label === 'nearexpiry' ? r.until + WINDOW : previous)
        expect(await expires(f, label)).toBe(r.E)
        expect(await logsOf(f.controller, r.hash, 'NameRenewed')).toMatchObject([
          { label, expires: r.E },
        ])
        expect(
          await logsOf(f.settlement, r.hash, 'NamePaymentReversible'),
        ).toEqual([
          {
            labelhash: labelhash(label),
            reversibleUntil: r.until,
            paidExpires: previous + YEAR,
            renewal: true,
          },
        ])
        expect(await payment(f, label)).toEqual([
          r.until,
          previous + YEAR,
          false,
          true,
        ])
      }
    })

    it('extends a name in its grace period to E', async () => {
      const f = await load()
      const first = await register(f, 'gracename', { days: 0n })
      await mineAt(first.paid + 10n * DAY)
      const r = await renew(f, 'gracename')
      expect(await expires(f, 'gracename')).toBe(r.until + WINDOW)
      expect(await f.baseRegistrar.read.ownerOf([id('gracename')])).toBe(
        getAddress(alice.address),
      )
    })

    it('renews the whole term with 0 days on both paths, and opens no entry', async () => {
      const f = await load()
      const first = await register(f, 'wholeterm', { days: 0n })
      await acceptRenewal(f, 'wholeterm')
      const paid = await payRenewal(f, 'wholeterm')
      await acceptRenewal(f, 'wholeterm')
      const credited = await creditRenewal(f, 'wholeterm')
      expect(await expires(f, 'wholeterm')).toBe(first.paid + 2n * YEAR)
      for (const hash of [paid, credited])
        expect(
          await logsOf(f.settlement, hash, 'NamePaymentReversible'),
        ).toEqual([])
      expect(await payment(f, 'wholeterm')).toEqual(NONE)
    })

    it('reverts DurationTooLong for a paid expiry beyond the horizon, for a general and a community name', async () => {
      const f = await load()
      await f.namePolicy.write.addCommunityNames([['community']], {
        account: guardian,
      })
      await register(f, 'horizonname', { days: 0n })
      const reg = registration('community', alice.address)
      await f.namePolicy.write.commitUnderCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), COMMUNITY_TERMS],
        { account: alice },
      )
      await f.sponsor.write.registerWithCredit(
        await signRegistration(connection, f.sponsor, reg),
        { account: registrar },
      )
      const sponsored = await f.controller.read.MAX_SPONSORED_REGISTRATION_DURATION()
      for (const [label, over, within] of [
        ['horizonname', sponsored - MIN_REGISTRATION + DAY, sponsored - MIN_REGISTRATION - DAY],
        ['community', 2n * YEAR, YEAR],
      ] as const) {
        const accept = async (duration: bigint) =>
          label === 'community'
            ? f.namePolicy.write.acceptCommunityTermsForRenewal(
                [id(label), await expires(f, label), duration, COMMUNITY_TERMS],
                { account: alice },
              )
            : acceptRenewal(f, label, alice, duration)
        await accept(over)
        await expect(
          f.sponsor.write.renewWithCredit(
            await signRenewal(connection, f.sponsor, label, over, alice.address, DAYS),
            { account: registrar },
          ),
        ).toBeRevertedWithCustomErrorFrom(f.controller, 'DurationTooLong')
        await accept(within)
        await f.sponsor.write.renewWithCredit(
          await signRenewal(connection, f.sponsor, label, within, alice.address, DAYS),
          { account: registrar },
        )
      }
    })

    it('checks the horizon at the paid expiry of a renewal that extends the first term', async () => {
      const f = await load()
      await f.namePolicy.write.addCommunityNames([['community']], {
        account: guardian,
      })
      const reg = registration('community', alice.address)
      await f.namePolicy.write.commitUnderCommunityTerms(
        [await f.controller.read.makeCommitment([reg]), COMMUNITY_TERMS],
        { account: alice },
      )
      await f.sponsor.write.registerWithCredit(
        await signRegistration(connection, f.sponsor, reg),
        { account: registrar },
      )
      const previous = await expires(f, 'community')
      await mineAt(previous - 60n * DAY)
      const at = previous - 60n * DAY + 1000n
      const horizon = await f.controller.read.MAX_REGISTRATION_DURATION()
      const over = at + horizon - previous + 1n
      const within = at + 1n + horizon - previous
      const signed: Awaited<ReturnType<typeof signRenewal>>[] = []
      for (const duration of [over, within]) {
        await f.namePolicy.write.acceptCommunityTermsForRenewal(
          [id('community'), previous, duration, COMMUNITY_TERMS],
          { account: alice },
        )
        signed.push(
          await signRenewal(connection, f.sponsor, 'community', duration, alice.address, DAYS),
        )
      }
      await exactly(at)
      await expect(
        f.sponsor.write.renewWithCredit(signed[0], { account: registrar, ...EXACT }),
      ).toBeRevertedWithCustomErrorFrom(f.controller, 'DurationTooLong')
      await exactly(at + 1n)
      await f.sponsor.write.renewWithCredit(signed[1], { account: registrar, ...EXACT })
      expect(await expires(f, 'community')).toBe(at + 1n + DAYS * DAY + WINDOW)
      expect((await payment(f, 'community'))[1]).toBe(at + 1n + horizon)
    })

    it('binds the reversible days, the holder, the label and the duration in RenewName', async () => {
      const f = await load()
      expect(await f.sponsor.read.RENEW_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'RenewName(string label,address holder,uint256 duration,uint256 reversibleDays,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
      const reg = registration('boundrenew', alice.address)
      await commitUnderGeneralTerms(connection, f.controller, reg, {
        account: alice,
      })
      await f.controller.write.register([reg], {
        account: alice,
        value: 2n * YEAR_PRICE_USD,
      })
      await acceptRenewal(f, 'boundrenew')
      const args = await signRenewal(
        connection,
        f.sponsor,
        'boundrenew',
        YEAR,
        alice.address,
        DAYS,
      )
      const [label, duration, referrer, holder, days, nonce, deadline, sig] = args
      expect(await f.sponsor.read.nonces([bob.address])).toBe(nonce)
      for (const tampered of [
        [label, duration, referrer, holder, days - 1n, nonce, deadline, sig],
        [label, duration, referrer, bob.address, days, nonce, deadline, sig],
        ['otherlabel', duration, referrer, holder, days, nonce, deadline, sig],
        [label, 2n * YEAR, referrer, holder, days, nonce, deadline, sig],
      ] as const)
        await expect(
          f.sponsor.write.renewWithCredit(tampered, { account: registrar }),
        ).toBeRevertedWithCustomError('InvalidSignature')
      await expect(
        f.sponsor.write.renewWithCredit(
          await signRenewal(connection, f.sponsor, 'boundrenew', YEAR, alice.address, DAYS, {
            deadline: 1n,
          }),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('SignatureExpired')
      await f.sponsor.write.renewWithCredit(args, { account: registrar })
      await expect(
        f.sponsor.write.renewWithCredit(args, { account: registrar }),
      ).toBeRevertedWithCustomError('InvalidNonce')
    })

    it('takes no RenewName from a registrar renewing its own name, or for 0 days', async () => {
      const f = await load()
      const own = registration('ownedbyreg', registrar.address)
      await commitUnderGeneralTerms(connection, f.controller, own, {
        account: registrar,
      })
      await f.sponsor.write.registerWithCredit([own, 0n, 0n, 0n, '0x'], {
        account: registrar,
      })
      await acceptRenewal(f, 'ownedbyreg', registrar)
      await f.sponsor.write.renewWithCredit(
        ['ownedbyreg', YEAR, zeroHash, registrar.address, DAYS, 0n, 0n, '0x'],
        { account: registrar },
      )
      expect((await payment(f, 'ownedbyreg'))[3]).toBe(true)

      await register(f, 'zerodays', { days: 0n })
      await acceptRenewal(f, 'zerodays')
      await creditRenewal(f, 'zerodays')
    })

    it('keeps the holder check and the renewal acceptance', async () => {
      const f = await load()
      await register(f, 'heldrenew', { days: 0n })
      await expect(
        f.sponsor.write.renewWithCredit(
          await signRenewal(connection, f.sponsor, 'heldrenew', YEAR, bob.address, DAYS),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'NotHolder')
      await expect(
        f.sponsor.write.renewWithCredit(
          await signRenewal(connection, f.sponsor, 'heldrenew', YEAR, alice.address, DAYS),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'TermsNotAccepted')
    })

    it('settles to the previous expiry plus the duration', async () => {
      const f = await load()
      const first = await register(f, 'settlerenew', { days: 0n })
      await mineAt(first.paid - 60n * DAY)
      const r = await renew(f, 'settlerenew')
      await mineAt(r.until)
      await expect(settle(f, 'settlerenew'))
        .toEmitEvent('NamePaymentSettled')
        .withArgs({ labelhash: labelhash('settlerenew'), expires: first.paid + YEAR })
      expect(await expires(f, 'settlerenew')).toBe(first.paid + YEAR)
    })

    it('withholds only the deferred term once reversed: the name keeps E, moves and renews', async () => {
      const f = await load()
      const first = await register(f, 'reversedrenew', { days: 0n })
      await mineAt(first.paid - 60n * DAY)
      const r = await renew(f, 'reversedrenew')
      await reverse(f, ['reversedrenew'])
      expect(await payment(f, 'reversedrenew')).toEqual(NONE)
      await expect(settle(f, 'reversedrenew')).toBeRevertedWithCustomError(
        'PaymentReversed',
      )
      await offer(f, 'reversedrenew')
      await claim(f, 'reversedrenew')
      await acceptRenewal(f, 'reversedrenew', bob)
      await payRenewal(f, 'reversedrenew', bob)
      expect(await expires(f, 'reversedrenew')).toBe(r.E + YEAR)
    })

    it('replaces the entry of a reversed renewal by a reversible renewal that keeps the expiry', async () => {
      const f = await load()
      const first = await register(f, 'replaced', { days: 0n })
      await renew(f, 'replaced')
      await reverse(f, ['replaced'])
      const second = await renew(f, 'replaced')
      expect(await expires(f, 'replaced')).toBe(first.paid)
      expect(await payment(f, 'replaced')).toEqual([
        second.until,
        first.paid + YEAR,
        false,
        true,
      ])
      await expect(reinstate(f, ['replaced']))
        .toEmitEvent('NamePaymentReinstatementSkipped')
        .withArgs({ label: 'replaced' })
      await mineAt(second.until)
      await settle(f, 'replaced')
      expect(await expires(f, 'replaced')).toBe(first.paid + YEAR)
    })

    it('reinstates the deferred term of a reversed renewal until the expiry changes', async () => {
      const f = await load()
      const first = await register(f, 'reinstated', { days: 0n })
      await register(f, 'renewedover', { days: 0n })
      await mineAt(first.paid - 60n * DAY)
      await renew(f, 'reinstated')
      const over = await renew(f, 'renewedover')
      await reverse(f, ['reinstated', 'renewedover'])
      await reinstate(f, ['reinstated'])
      expect(await expires(f, 'reinstated')).toBe(first.paid + YEAR)
      await acceptRenewal(f, 'renewedover')
      await payRenewal(f, 'renewedover')
      expect(await expires(f, 'renewedover')).toBe(over.E + YEAR)
      await expect(reinstate(f, ['renewedover']))
        .toEmitEvent('NamePaymentReinstatementSkipped')
        .withArgs({ label: 'renewedover' })
      expect(await expires(f, 'renewedover')).toBe(over.E + YEAR)
    })
  })

  describe('renewal before settlement', () => {
    it('reverts PaymentNotSettled on both paths until a registration settles, and takes a new acceptance after', async () => {
      const f = await load()
      const r = await register(f, 'unsettled')
      await acceptRenewal(f, 'unsettled')
      await expect(payRenewal(f, 'unsettled')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'PaymentNotSettled',
      )
      await expect(creditRenewal(f, 'unsettled')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'PaymentNotSettled',
      )
      await mineAt(r.until)
      await settle(f, 'unsettled')
      await expect(payRenewal(f, 'unsettled')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'TermsNotAccepted',
      )
      await acceptRenewal(f, 'unsettled')
      await payRenewal(f, 'unsettled')
      expect(await expires(f, 'unsettled')).toBe(r.paid + YEAR)
    })

    it('reverts PaymentNotSettled until a reversible renewal settles', async () => {
      const f = await load()
      const first = await register(f, 'renewtwice', { days: 0n })
      const r = await renew(f, 'renewtwice')
      await acceptRenewal(f, 'renewtwice')
      await expect(payRenewal(f, 'renewtwice')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'PaymentNotSettled',
      )
      await expect(creditRenewal(f, 'renewtwice')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'PaymentNotSettled',
      )
      await mineAt(r.until)
      await settle(f, 'renewtwice')
      await acceptRenewal(f, 'renewtwice')
      await creditRenewal(f, 'renewtwice')
      expect(await expires(f, 'renewtwice')).toBe(first.paid + 2n * YEAR)
    })
  })

  describe('settlement', () => {
    it('reverts before reversibleUntil and settles from it, for anyone', async () => {
      const f = await load()
      const r = await register(f, 'settleedge')
      await exactly(r.until - 1n)
      await expect(settle(f, 'settleedge', EXACT)).toBeRevertedWithCustomError(
        'ReversiblePeriodNotEnded',
      )
      await exactly(r.until)
      await expect(settle(f, 'settleedge', EXACT))
        .toEmitEvent('NamePaymentSettled')
        .withArgs({ labelhash: labelhash('settleedge'), expires: r.paid })
      expect(await expires(f, 'settleedge')).toBe(r.paid)
      expect(await payment(f, 'settleedge')).toEqual(NONE)
    })

    it('settles up to E + 90 days, and reverts NotReversible after it and a second time', async () => {
      const f = await load()
      const last = await register(f, 'lastday')
      const late = await register(f, 'toolate')
      await exactly(last.E + GRACE)
      await settle(f, 'lastday', EXACT)
      expect(await expires(f, 'lastday')).toBe(last.paid)
      await expect(settle(f, 'lastday')).toBeRevertedWithCustomError(
        'NotReversible',
      )
      await exactly(late.E + GRACE + 1n)
      await expect(settle(f, 'toolate', EXACT)).toBeRevertedWithCustomError(
        'NotReversible',
      )
    })

    it('settles a reserved name', async () => {
      const f = await load()
      const r = await register(f, 'reservedcard')
      await f.namePolicy.write.addReservedNames(
        [['reservedcard'], Reason.Trademark],
        { account: guardian },
      )
      await mineAt(r.until)
      await settle(f, 'reservedcard')
      expect(await expires(f, 'reservedcard')).toBe(r.paid)
    })

    it('restores the subnames owner in the grace period', async () => {
      const f = await load()
      const r = await register(f, 'subparent')
      const sub = await withSubname(f, 'subparent')
      await mineAt(r.E + 1n)
      expect(await f.subnameRegistrar.read.ownerOf([sub])).toBe(zeroAddress)
      await settle(f, 'subparent')
      expect(await f.subnameRegistrar.read.ownerOf([sub])).toBe(
        getAddress(alice.address),
      )
    })
  })

  describe('reversal', () => {
    it('refuses the claim and the settlement, and the name lapses at E', async () => {
      const f = await load()
      const r = await register(f, 'reversedname')
      await offer(f, 'reversedname')
      await expect(reverse(f, ['reversedname']))
        .toEmitEvent('NamePaymentReversed')
        .withArgs({ labelhash: labelhash('reversedname') })
      expect(await payment(f, 'reversedname')).toEqual([
        r.until,
        r.paid,
        true,
        false,
      ])
      await expect(claim(f, 'reversedname')).toBeRevertedWithCustomErrorFrom(
        f.namePolicy,
        'PaymentReversed',
      )
      await expect(settle(f, 'reversedname')).toBeRevertedWithCustomError(
        'PaymentReversed',
      )
      await mineAt(r.E - 1n)
      expect(await f.baseRegistrar.read.ownerOf([id('reversedname')])).toBe(
        getAddress(alice.address),
      )
      await mineAt(r.E)
      await expect(
        f.baseRegistrar.read.ownerOf([id('reversedname')]),
      ).toBeRevertedWithoutReason()
      await mineAt(r.E + GRACE)
      expect(await f.baseRegistrar.read.available([id('reversedname')])).toBe(
        false,
      )
      await mineAt(r.E + GRACE + 1n)
      expect(await f.baseRegistrar.read.available([id('reversedname')])).toBe(
        true,
      )
    })

    it('reverses before reversibleUntil and skips the name from it', async () => {
      const f = await load()
      const before = await register(f, 'daybefore')
      const on = await register(f, 'deadlineday')
      await exactly(before.until - 1n)
      await reverse(f, ['daybefore'], guardian, EXACT)
      await exactly(on.until)
      await expect(reverse(f, ['deadlineday'], guardian, EXACT))
        .toEmitEvent('NamePaymentReversalSkipped')
        .withArgs({ label: 'deadlineday' })
      expect((await payment(f, 'daybefore'))[2]).toBe(true)
      expect((await payment(f, 'deadlineday'))[2]).toBe(false)
    })

    it('is made by the guardian or the admin only', async () => {
      const f = await load()
      await register(f, 'byguardian')
      await register(f, 'byadmin')
      for (const account of [registrar, alice, carol])
        await expect(
          reverse(f, ['byguardian'], account),
        ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
      await reverse(f, ['byguardian'], guardian)
      await reverse(f, ['byadmin'], owner)
      for (const label of ['byguardian', 'byadmin'])
        expect((await payment(f, label))[2]).toBe(true)
    })

    it('reverses several names in one call and skips the others with NamePaymentReversalSkipped', async () => {
      const f = await load()
      const late = await register(f, 'pastdeadline', { days: 1n })
      await mineAt(late.until + 1n)
      await register(f, 'firstcard')
      await register(f, 'secondcard')
      await register(f, 'paidincrypto', { days: 0n })
      const hash = await reverse(f, [
        'firstcard',
        'secondcard',
        'paidincrypto',
        'pastdeadline',
        'firstcard',
        'neverregistered',
      ])
      expect(await logsOf(f.settlement, hash, 'NamePaymentReversed')).toEqual([
        { labelhash: labelhash('firstcard') },
        { labelhash: labelhash('secondcard') },
      ])
      expect(
        await logsOf(f.settlement, hash, 'NamePaymentReversalSkipped'),
      ).toEqual([
        { label: 'paidincrypto' },
        { label: 'pastdeadline' },
        { label: 'firstcard' },
        { label: 'neverregistered' },
      ])
    })
  })

  describe('reinstatement', () => {
    it('adds the deferred term at once and ends the entry', async () => {
      const f = await load()
      const r = await register(f, 'reinstate')
      await expect(reinstate(f, ['reinstate']))
        .toEmitEvent('NamePaymentReinstatementSkipped')
        .withArgs({ label: 'reinstate' })
      expect(await expires(f, 'reinstate')).toBe(r.E)
      await reverse(f, ['reinstate'])
      await expect(reinstate(f, ['reinstate']))
        .toEmitEvent('NamePaymentSettled')
        .withArgs({ labelhash: labelhash('reinstate'), expires: r.paid })
      expect(await expires(f, 'reinstate')).toBe(r.paid)
      expect(await payment(f, 'reinstate')).toEqual(NONE)
      await expect(reverse(f, ['reinstate']))
        .toEmitEvent('NamePaymentReversalSkipped')
        .withArgs({ label: 'reinstate' })
      await expect(reinstate(f, ['reinstate']))
        .toEmitEvent('NamePaymentReinstatementSkipped')
        .withArgs({ label: 'reinstate' })
      expect(await expires(f, 'reinstate')).toBe(r.paid)
      await expect(settle(f, 'reinstate')).toBeRevertedWithCustomError(
        'NotReversible',
      )
      await offer(f, 'reinstate')
      await claim(f, 'reinstate')
    })

    it('reinstates up to E + 90 days', async () => {
      const f = await load()
      const last = await register(f, 'reinstatelast')
      const late = await register(f, 'reinstatelate')
      await reverse(f, ['reinstatelast', 'reinstatelate'])
      await exactly(last.E + GRACE)
      await reinstate(f, ['reinstatelast'], owner, EXACT)
      expect(await expires(f, 'reinstatelast')).toBe(last.paid)
      await exactly(late.E + GRACE + 1n)
      await expect(reinstate(f, ['reinstatelate'], owner, EXACT))
        .toEmitEvent('NamePaymentReinstatementSkipped')
        .withArgs({ label: 'reinstatelate' })
      expect(await expires(f, 'reinstatelate')).toBe(late.E)
    })

    it('reinstates the eligible names of a batch and skips the others with NamePaymentReinstatementSkipped', async () => {
      const f = await load()
      await register(f, 'firstwon')
      const second = await register(f, 'secondwon')
      await register(f, 'notreversed')
      await register(f, 'renewedfirst', { days: 0n })
      await renew(f, 'renewedfirst')
      await reverse(f, ['secondwon', 'renewedfirst'])
      await mineAt(second.until)
      await settle(f, 'firstwon')
      await acceptRenewal(f, 'renewedfirst')
      await payRenewal(f, 'renewedfirst')
      const hash = await reinstate(f, [
        'firstwon',
        'secondwon',
        'notreversed',
        'renewedfirst',
        'secondwon',
        'neverregistered',
      ])
      expect(await logsOf(f.settlement, hash, 'NamePaymentSettled')).toEqual([
        { labelhash: labelhash('secondwon'), expires: second.paid },
      ])
      expect(
        await logsOf(f.settlement, hash, 'NamePaymentReinstatementSkipped'),
      ).toEqual([
        { label: 'firstwon' },
        { label: 'notreversed' },
        { label: 'renewedfirst' },
        { label: 'secondwon' },
        { label: 'neverregistered' },
      ])
    })

    it('is made by the admin only', async () => {
      const f = await load()
      await register(f, 'adminonly')
      await reverse(f, ['adminonly'])
      for (const account of [guardian, registrar, alice])
        await expect(
          reinstate(f, ['adminonly'], account),
        ).toBeRevertedWithCustomError('NotOwner')
    })
  })

  describe('transfers', () => {
    it('refuses every claim path after a reversal', async () => {
      const f = await load()
      await register(f, 'noclaim')
      await offer(f, 'noclaim')
      await reverse(f, ['noclaim'])
      const tokenId = id('noclaim')
      for (const transfer of [
        () =>
          f.baseRegistrar.write.transferFrom([alice.address, bob.address, tokenId], {
            account: bob,
          }),
        () =>
          f.baseRegistrar.write.safeTransferFrom(
            [alice.address, bob.address, tokenId],
            { account: bob },
          ),
        () =>
          f.baseRegistrar.write.safeTransferFrom(
            [alice.address, bob.address, tokenId, '0x'],
            { account: bob },
          ),
      ])
        await expect(transfer()).toBeRevertedWithCustomErrorFrom(
          f.namePolicy,
          'PaymentReversed',
        )
      const offerNumber = await f.baseRegistrar.read.offers([tokenId])
      const nonce = await f.baseRegistrar.read.nonces([bob.address])
      const sig = await signIntent(
        publicClient,
        bobClient,
        'SimplexNames',
        f.baseRegistrar.address,
        'ClaimName',
        {
          from: alice.address,
          to: bob.address,
          tokenId,
          offer: offerNumber,
          nonce,
          deadline: FAR_FUTURE,
        },
      )
      await expect(
        f.baseRegistrar.write.claimWithSig(
          [alice.address, bob.address, tokenId, offerNumber, nonce, FAR_FUTURE, sig],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'PaymentReversed')
    })

    it('keeps approve and approveWithSig after a reversal', async () => {
      const f = await load()
      await register(f, 'stilloffered')
      await reverse(f, ['stilloffered'])
      const tokenId = id('stilloffered')
      await f.baseRegistrar.write.approve([bob.address, tokenId], {
        account: alice,
      })
      expect(await f.baseRegistrar.read.getApproved([tokenId])).toBe(
        getAddress(bob.address),
      )
      const nonce = await f.baseRegistrar.read.nonces([alice.address])
      const sig = await signIntent(
        publicClient,
        aliceClient,
        'SimplexNames',
        f.baseRegistrar.address,
        'ApproveName',
        {
          from: alice.address,
          to: carol.address,
          tokenId,
          ephemeralPubKey: '0x',
          viewTag: '0x00',
          nonce,
          deadline: FAR_FUTURE,
        },
      )
      await f.baseRegistrar.write.approveWithSig(
        [alice.address, carol.address, tokenId, nonce, FAR_FUTURE, sig, '0x', '0x00'],
        { account: registrar },
      )
      expect(await f.baseRegistrar.read.getApproved([tokenId])).toBe(
        getAddress(carol.address),
      )
    })

    it('moves the name on a claim before the reversal, which then binds the new holder', async () => {
      const f = await load()
      await register(f, 'soldearly')
      await offer(f, 'soldearly')
      await claim(f, 'soldearly')
      await reverse(f, ['soldearly'])
      await offer(f, 'soldearly', bob, carol)
      await expect(
        claim(f, 'soldearly', bob, carol),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'PaymentReversed')
      await acceptRenewal(f, 'soldearly', bob)
      await expect(
        payRenewal(f, 'soldearly', bob),
      ).toBeRevertedWithCustomErrorFrom(f.namePolicy, 'PaymentNotSettled')
    })

    it('moves the name on a claim from reversibleUntil to E, and a reversal then skips it', async () => {
      const f = await load()
      const r = await register(f, 'soldlate')
      await mineAt(r.until)
      await offer(f, 'soldlate')
      await claim(f, 'soldlate')
      await expect(reverse(f, ['soldlate']))
        .toEmitEvent('NamePaymentReversalSkipped')
        .withArgs({ label: 'soldlate' })
    })

    it('keeps the subnames owner from reversibleUntil to E', async () => {
      const f = await load()
      const r = await register(f, 'subkeeper')
      const sub = await withSubname(f, 'subkeeper')
      for (const time of [r.until, r.E - 1n]) {
        await mineAt(time)
        expect(await f.subnameRegistrar.read.ownerOf([sub])).toBe(
          getAddress(alice.address),
        )
      }
    })
  })

  describe('stale and lapsed entries', () => {
    it('ignores the entry after a re-registration, by the sponsor or by registerReserved', async () => {
      const f = await load()
      await register(f, 'relapsed')
      const reserved = await register(f, 'rebranded')
      await reverse(f, ['relapsed', 'rebranded'])
      await f.namePolicy.write.addReservedNames(
        [['rebranded'], Reason.Trademark],
        { account: guardian },
      )
      await mineAt(reserved.E + GRACE + 1n)
      await register(f, 'relapsed', { holder: bob, days: 0n })
      await f.namePolicy.write.registerReserved(
        ['rebranded', bob.address, MIN_REGISTRATION],
        { account: owner },
      )
      for (const label of ['relapsed', 'rebranded']) {
        expect(await payment(f, label)).toEqual(NONE)
        await offer(f, label, bob, carol)
        await claim(f, label, bob, carol)
      }
    })

    it('ignores the entry after a renewal by another registrar controller', async () => {
      const f = await load()
      const r = await register(f, 'othercontroller')
      await f.baseRegistrar.write.addController([carol.address], {
        account: owner,
      })
      await f.baseRegistrar.write.renew([id('othercontroller'), 1n], {
        account: carol,
      })
      expect(await payment(f, 'othercontroller')).toEqual(NONE)
      await expect(reverse(f, ['othercontroller']))
        .toEmitEvent('NamePaymentReversalSkipped')
        .withArgs({ label: 'othercontroller' })
      await mineAt(r.until)
      await expect(settle(f, 'othercontroller')).toBeRevertedWithCustomError(
        'NotReversible',
      )
    })

    it('answers the entry up to E + 90 days and zeros after it', async () => {
      const f = await load()
      const r = await register(f, 'viewedge')
      await mineAt(r.E + GRACE)
      expect(await payment(f, 'viewedge')).toEqual([r.until, r.paid, false, false])
      await mineAt(r.E + GRACE + 1n)
      expect(await payment(f, 'viewedge')).toEqual(NONE)
    })
  })

  describe('invariants', () => {
    it('keeps the longest first term below the shortest registration and renewal', async () => {
      const f = await load()
      const firstTerm =
        (await f.settlement.read.MAX_REVERSIBLE_DAYS()) * DAY +
        (await f.settlement.read.SETTLEMENT_WINDOW())
      expect(firstTerm).toBe(DAYS * DAY + WINDOW)
      expect(firstTerm < (await f.controller.read.MIN_REGISTRATION_DURATION())).toBe(
        true,
      )
      expect(
        firstTerm + (await f.baseRegistrar.read.GRACE_PERIOD()) <
          (await f.controller.read.MIN_RENEWAL_DURATION()),
      ).toBe(true)
    })
  })

  describe('upgrades', () => {
    const boundTo = (controller: `0x${string}`, registrar: `0x${string}`) =>
      connection.viem.deployContract('SimplexSettlement', [controller, registrar])

    it('upgrades the settlement by the controller owner only, keeping its entries, until the freeze', async () => {
      const f = await load()
      const r = await register(f, 'upgraded')
      const next = await boundTo(f.controller.address, f.baseRegistrar.address)
      await expect(
        f.settlement.write.upgradeTo([next.address], { account: guardian }),
      ).toBeRevertedWithCustomError('NotOwner')
      for (const other of [
        await boundTo(f.implementation.address, f.baseRegistrar.address),
        await boundTo(f.controller.address, alice.address),
      ])
        await expect(
          f.settlement.write.upgradeTo([other.address], { account: owner }),
        ).toBeRevertedWithCustomError('ImplementationMismatch')
      await expect(
        f.settlement.write.upgradeTo([next.address], { account: owner }),
      )
        .toEmitEvent('Upgraded')
        .withArgs({ implementation: getAddress(next.address) })
      expect(await payment(f, 'upgraded')).toEqual([r.until, r.paid, false, false])
      await f.controller.write.freeze({ account: owner })
      await expect(
        f.settlement.write.upgradeTo([next.address], { account: owner }),
      ).toBeRevertedWithCustomError('Frozen')
    })

    it('answers NotProxy from the implementation', async () => {
      const f = await load()
      await expect(
        f.settlementImplementation.read.reversiblePayment([id('anyname')]),
      ).toBeRevertedWithCustomError('NotProxy')
      await expect(
        f.settlementImplementation.write.reversePayments([['anyname']], {
          account: guardian,
        }),
      ).toBeRevertedWithCustomError('NotProxy')
      await expect(
        f.settlementImplementation.write.reinstatePayments([['anyname']], {
          account: owner,
        }),
      ).toBeRevertedWithCustomError('NotProxy')
    })

    it('builds a name policy only on a settlement proxy of its own controller and registrar', async () => {
      const f = await load()
      const policyOn = (settlement: `0x${string}`) =>
        connection.viem.deployContract('SimplexNamePolicy', [
          f.controller.address,
          f.baseRegistrar.address,
          settlement,
        ])
      for (const [controller, registrar, error] of [
        [f.implementation.address, f.baseRegistrar.address, 'ImplementationMismatch()'],
        [f.controller.address, alice.address, 'ImplementationMismatch()'],
      ] as const)
        await expect(
          policyOn((await deploySettlement(connection, controller, registrar)).settlement.address),
        ).rejects.toThrow(toFunctionSelector(error).slice(2))
      await expect(policyOn(f.settlementImplementation.address)).rejects.toThrow(
        toFunctionSelector('NotProxy()').slice(2),
      )
      const other = await deploySettlement(
        connection,
        f.controller.address,
        f.baseRegistrar.address,
      )
      expect(await (await policyOn(other.settlement.address)).read.settlement()).toBe(
        getAddress(other.settlement.address),
      )
    })

    it('refuses to upgrade the name policy to the #49 implementation', async () => {
      const f = await load()
      const previous = await connection.viem.deployContract(
        await artifact('7ff8c37', 'SimplexNamePolicy'),
        [f.controller.address, f.baseRegistrar.address],
      )
      await expect(
        f.namePolicy.write.upgradeTo([previous.address], { account: owner }),
      ).toBeRevertedWithoutReason()
    })

    it('ends an entry by a renewal through the v1 controller implementation', async () => {
      const f = await load()
      const r = await register(f, 'v1renewal')
      const v1 = await connection.viem.deployContract(
        await artifact('1a11cda', 'SimplexController'),
        [],
      )
      await f.controller.write.upgradeTo([v1.address], { account: owner })
      await f.controller.write.renew(['v1renewal', YEAR, zeroHash], {
        account: carol,
        value: YEAR_PRICE_USD,
      })
      expect(await expires(f, 'v1renewal')).toBe(r.E + YEAR)
      expect(await payment(f, 'v1renewal')).toEqual(NONE)
      await mineAt(r.until)
      await expect(settle(f, 'v1renewal')).toBeRevertedWithCustomError(
        'NotReversible',
      )
    })
  })

  describe('from the #49 deployment', () => {
    async function previousFixture() {
      const f = await fixture()
      const previousController = await connection.viem.deployContract(
        await artifact('7ff8c37', 'SimplexController'),
        [],
      )
      await f.controller.write.upgradeTo([previousController.address], {
        account: owner,
      })
      const policyImplementation = await connection.viem.deployContract(
        await artifact('7ff8c37', 'SimplexNamePolicy'),
        [f.controller.address, f.baseRegistrar.address],
      )
      const policyProxy = await connection.viem.deployContract(
        'SimplexNamePolicyProxy',
        [policyImplementation.address, '0x'],
      )
      const namePolicy = await connection.viem.getContractAt(
        'SimplexNamePolicy',
        policyProxy.address,
      )
      await f.baseRegistrar.write.removeController([f.namePolicy.address])
      await f.baseRegistrar.write.removeController([f.settlement.address])
      await f.baseRegistrar.write.addController([namePolicy.address])
      await f.controller.write.setNamePolicy([namePolicy.address], {
        account: owner,
      })
      await namePolicy.write.setGeneralTerms([GENERAL_TERMS_LINK], {
        account: owner,
      })
      await namePolicy.write.setCommunityTerms([COMMUNITY_TERMS_LINK], {
        account: owner,
      })
      await f.baseRegistrar.write.setNamePolicy([namePolicy.address])
      const sponsor = await connection.viem.deployContract(
        await artifact('7ff8c37', 'SimplexSponsor'),
        [f.controller.address],
      )
      await f.controller.write.setSponsor([sponsor.address], { account: owner })
      await sponsor.write.setRegistrarAllowance(
        [registrar.address, AMPLE_ALLOWANCE],
        { account: guardian },
      )
      return { ...f, namePolicy, sponsor, previousController }
    }
    const loadPrevious = () =>
      connection.networkHelpers.loadFixture(previousFixture)
    type Previous = Awaited<ReturnType<typeof previousFixture>>

    async function registerPaid(p: Previous, label: string) {
      const reg = registration(label, alice.address)
      await commitUnderGeneralTerms(connection, p.controller, reg, {
        account: alice,
      })
      await p.controller.write.register([reg], {
        account: alice,
        value: 2n * YEAR_PRICE_USD,
      })
    }

    async function deployCurrent(p: Previous) {
      const { settlement } = await deploySettlement(
        connection,
        p.controller.address,
        p.baseRegistrar.address,
      )
      const controllerImplementation = await connection.viem.deployContract(
        'SimplexController',
        [],
      )
      const policyImplementation = await connection.viem.deployContract(
        'SimplexNamePolicy',
        [p.controller.address, p.baseRegistrar.address, settlement.address],
      )
      const sponsor = await connection.viem.deployContract('SimplexSponsor', [
        p.controller.address,
      ])
      return { settlement, controllerImplementation, policyImplementation, sponsor }
    }

    async function moveAndRenew(p: Previous, label: string, from: Account, to: Account) {
      const f = p as unknown as Fixture
      await offer(f, label, from, to)
      await claim(f, label, from, to)
      await connection.networkHelpers.time.increase(YEAR)
      await acceptRenewal(f, label, to)
      await payRenewal(f, label, to)
    }

    const SCAN = 400
    async function snapshot(address: `0x${string}`) {
      const slots: (string | undefined)[] = []
      for (let i = 0; i < SCAN; i++)
        slots.push(await publicClient.getStorageAt({ address, slot: pad(toHex(i)) }))
      return slots
    }

    it('keeps every value of the #49 proxies through the upgrade', async () => {
      const p = await loadPrevious()
      await p.controller.write.setMinCharLength([5], { account: owner })
      await p.namePolicy.write.addReservedNames([['brandname'], Reason.Trademark], {
        account: guardian,
      })
      await p.namePolicy.write.addCommunityNames([['community']], {
        account: guardian,
      })
      await registerPaid(p, 'keptname')
      await acceptRenewal(p as unknown as Fixture, 'keptname')
      await offer(p as unknown as Fixture, 'keptname')
      const commitment = await p.controller.read.makeCommitment([
        registration('community', bob.address),
      ])
      await p.namePolicy.write.commitUnderCommunityTerms(
        [commitment, COMMUNITY_TERMS],
        { account: bob },
      )
      const tokenId = id('keptname')
      const values = async () => [
        await p.controller.read.minCharLength(),
        await p.controller.read.commitments([commitment]),
        await p.namePolicy.read.reservedNames([labelhash('brandname')]),
        await p.namePolicy.read.communityNames([labelhash('community')]),
        await p.namePolicy.read.acceptedTerms([commitment, bob.address]),
        await p.namePolicy.read.acceptedClaimTerms([
          tokenId,
          alice.address,
          bob.address,
          await p.baseRegistrar.read.offers([tokenId]),
        ]),
        await p.namePolicy.read.acceptedRenewalTerms([
          tokenId,
          alice.address,
          await p.baseRegistrar.read.nameExpires([tokenId]),
          YEAR,
        ]),
        await p.namePolicy.read.generalTermsLink(),
        await p.namePolicy.read.communityTermsLink(),
      ]
      const valuesBefore = await values()
      expect(valuesBefore).not.toContain(0n)
      expect(valuesBefore).not.toContain(zeroHash)
      const controllerBefore = await snapshot(p.controller.address)
      const policyBefore = await snapshot(p.namePolicy.address)

      const next = await deployCurrent(p)
      await p.baseRegistrar.write.addController([next.settlement.address])
      await p.namePolicy.write.upgradeTo([next.policyImplementation.address], {
        account: owner,
      })
      await p.controller.write.upgradeToAndCall(
        [
          next.controllerImplementation.address,
          encodeFunctionData({
            abi: p.controller.abi,
            functionName: 'setSponsor',
            args: [next.sponsor.address],
          }),
        ],
        { account: owner },
      )

      const controllerAfter = await snapshot(p.controller.address)
      const changed = controllerBefore.flatMap((slot, i) =>
        slot === controllerAfter[i] ? [] : [i],
      )
      expect(changed).toHaveLength(1)
      expect(controllerAfter[changed[0]]).toBe(
        pad(next.sponsor.address).toLowerCase(),
      )
      expect(await snapshot(p.namePolicy.address)).toEqual(policyBefore)
      expect(await values()).toEqual(valuesBefore)
      expect(await p.namePolicy.read.settlement()).toBe(
        getAddress(next.settlement.address),
      )
    })

    it('keeps transfers and renewals working at each step of the upgrade and of the rollback', async () => {
      const p = await loadPrevious()
      const f = p as unknown as Fixture
      await registerPaid(p, 'stepname')

      const next = await deployCurrent(p)
      await moveAndRenew(p, 'stepname', alice, bob)

      await p.baseRegistrar.write.addController([next.settlement.address])
      await moveAndRenew(p, 'stepname', bob, alice)

      await p.namePolicy.write.upgradeTo([next.policyImplementation.address], {
        account: owner,
      })
      await moveAndRenew(p, 'stepname', alice, bob)
      await acceptRenewal(f, 'stepname', bob)
      await p.sponsor.write.renewWithCredit(
        ['stepname', YEAR, zeroHash, bob.address],
        { account: registrar },
      )

      await next.sponsor.write.setRegistrarAllowance(
        [registrar.address, AMPLE_ALLOWANCE],
        { account: guardian },
      )
      await p.controller.write.upgradeToAndCall(
        [
          next.controllerImplementation.address,
          encodeFunctionData({
            abi: p.controller.abi,
            functionName: 'setSponsor',
            args: [next.sponsor.address],
          }),
        ],
        { account: owner },
      )
      const current = { ...f, sponsor: next.sponsor, settlement: next.settlement }
      await moveAndRenew(p, 'stepname', bob, alice)
      const r = await register(current, 'cardname')
      await acceptRenewal(current, 'cardname')
      await expect(payRenewal(current, 'cardname')).toBeRevertedWithCustomErrorFrom(
        p.namePolicy,
        'PaymentNotSettled',
      )
      await registerPaid(p, 'unsettledname')
      await renew(current, 'unsettledname')
      await reverse(current, ['cardname'])
      await offer(current, 'cardname')
      await expect(claim(current, 'cardname')).toBeRevertedWithCustomErrorFrom(
        p.namePolicy,
        'PaymentReversed',
      )

      const rollbackSponsor = await connection.viem.deployContract(
        await artifact('7ff8c37', 'SimplexSponsor'),
        [p.controller.address],
      )
      await rollbackSponsor.write.setRegistrarAllowance(
        [registrar.address, AMPLE_ALLOWANCE],
        { account: guardian },
      )
      await p.controller.write.upgradeToAndCall(
        [
          p.previousController.address,
          encodeFunctionData({
            abi: p.controller.abi,
            functionName: 'setSponsor',
            args: [rollbackSponsor.address],
          }),
        ],
        { account: owner },
      )
      await acceptRenewal(f, 'unsettledname')
      await expect(payRenewal(f, 'unsettledname')).toBeRevertedWithCustomErrorFrom(
        p.namePolicy,
        'PaymentNotSettled',
      )
      await expect(
        rollbackSponsor.write.renewWithCredit(
          ['unsettledname', YEAR, zeroHash, alice.address],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomErrorFrom(p.namePolicy, 'PaymentNotSettled')
      await expect(claim(current, 'cardname')).toBeRevertedWithCustomErrorFrom(
        p.namePolicy,
        'PaymentReversed',
      )
      await reinstate(current, ['cardname'])
      expect(await expires(f, 'cardname')).toBe(r.paid)
      await claim(current, 'cardname')
      await moveAndRenew(p, 'stepname', alice, bob)
    })
  })
})
