import hre from 'hardhat'
import {
  concat,
  getAddress,
  keccak256,
  labelhash,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import {
  acceptGeneralTermsForClaim,
  acceptGeneralTermsForRenewal,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  MIN_DISPUTE_DAYS,
  MIN_REGISTRATION,
  node,
  Reason,
  registration,
  signRegistration,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const MAX_DISPUTE_DAYS = 120n
const KEY = 'simplex.contact'
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

async function timeOf(hash: `0x${string}`) {
  const { blockNumber } = await publicClient.waitForTransactionReceipt({ hash })
  return (await publicClient.getBlock({ blockNumber })).timestamp
}

const exactly = (timestamp: bigint) =>
  testClient.setNextBlockTimestamp({ timestamp })

async function sponsored(
  f: Fixture,
  label: string,
  {
    holder = alice,
    days = MIN_DISPUTE_DAYS,
    resolver = zeroAddress,
  }: Partial<{ holder: Account; days: bigint; resolver: `0x${string}` }> = {},
) {
  const reg = registration(label, holder.address, { resolver })
  await commitUnderGeneralTerms(connection, f.controller, reg, {
    account: holder,
  })
  const hash = await f.sponsor.write.registerWithCredit(
    await signRegistration(connection, f.sponsor, reg, { disputeDays: days }),
    { account: registrar },
  )
  return (await timeOf(hash)) + days * DAY
}

async function paid(f: Fixture, label: string, holder: Account = alice) {
  const reg = registration(label, holder.address)
  await commitUnderGeneralTerms(connection, f.controller, reg, {
    account: holder,
  })
  return timeOf(
    await f.controller.write.register([reg], {
      account: holder,
      value: 2n * YEAR_PRICE_USD,
    }),
  )
}

const unregister = (
  f: Fixture,
  label: string,
  account: Account = guardian,
  options = {},
) => f.controller.write.unregister([label], { account, ...options })

async function withSubname(f: Fixture, label: string) {
  await f.ens.write.setApprovalForAll([f.subnameRegistrar.address, true], {
    account: alice,
  })
  await f.subnameRegistrar.write.createSubname([node(label), 'pay'], {
    account: alice,
  })
  return BigInt(keccak256(concat([node(label), labelhash('pay')])))
}

describe('dispute period', () => {
  describe('registration', () => {
    it('stores the end of a sponsored registration of 14 to 120 days', async () => {
      const f = await load()
      for (const [label, days] of [
        ['fourteendays', MIN_DISPUTE_DAYS],
        ['hundredtwenty', MAX_DISPUTE_DAYS],
      ] as const) {
        const until = await sponsored(f, label, { days })
        expect(await f.baseRegistrar.read.disputeUntil([id(label)])).toBe(until)
      }
      expect(await f.controller.read.MIN_DISPUTE_DAYS()).toBe(MIN_DISPUTE_DAYS)
      expect(await f.controller.read.MAX_DISPUTE_DAYS()).toBe(MAX_DISPUTE_DAYS)
    })

    it('reverts DisputeDaysOutOfRange below 14 and above 120 days', async () => {
      const f = await load()
      for (const [label, days] of [
        ['thirteendays', MIN_DISPUTE_DAYS - 1n],
        ['zerodaysname', 0n],
        ['toomanydays', MAX_DISPUTE_DAYS + 1n],
      ] as const) {
        const reg = registration(label, alice.address)
        await commitUnderGeneralTerms(connection, f.controller, reg, {
          account: alice,
        })
        await expect(
          f.sponsor.write.registerWithCredit(
            await signRegistration(connection, f.sponsor, reg, {
              disputeDays: days,
            }),
            { account: registrar },
          ),
        ).toBeRevertedWithCustomErrorFrom(f.controller, 'DisputeDaysOutOfRange')
      }
    })

    it('binds the dispute days in RegisterName', async () => {
      const f = await load()
      const reg = registration('signeddays', alice.address)
      await commitUnderGeneralTerms(connection, f.controller, reg, {
        account: alice,
      })
      const [, days, nonce, deadline, sig] = await signRegistration(
        connection,
        f.sponsor,
        reg,
        { disputeDays: MAX_DISPUTE_DAYS },
      )
      await expect(
        f.sponsor.write.registerWithCredit(
          [reg, MIN_DISPUTE_DAYS, nonce, deadline, sig],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('InvalidSignature')
      await f.sponsor.write.registerWithCredit([reg, days, nonce, deadline, sig], {
        account: registrar,
      })
    })

    it('gives the payable path and registerReserved no dispute period', async () => {
      const f = await load()
      await paid(f, 'paidineth')
      expect(await f.baseRegistrar.read.disputeUntil([id('paidineth')])).toBe(0n)
      await f.namePolicy.write.addReservedNames(
        [['brandname'], Reason.Trademark],
        { account: guardian },
      )
      await f.namePolicy.write.registerReserved(
        ['brandname', bob.address, MIN_REGISTRATION],
        { account: owner },
      )
      for (const label of ['paidineth', 'brandname'])
        await expect(unregister(f, label)).toBeRevertedWithCustomErrorFrom(
          f.baseRegistrar,
          'DisputePeriodOver',
        )
    })
  })

  describe('unregistration', () => {
    it('is made by the guardian or the admin, before the end of the dispute period', async () => {
      const f = await load()
      await sponsored(f, 'byguardian')
      await sponsored(f, 'byadmin')
      const lastSecond = await sponsored(f, 'lastsecond')
      const atEnd = await sponsored(f, 'atitsend')
      for (const account of [registrar, alice, carol])
        await expect(
          unregister(f, 'byguardian', account),
        ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
      await unregister(f, 'byguardian', guardian)
      await unregister(f, 'byadmin', owner)
      await exactly(lastSecond - 1n)
      await unregister(f, 'lastsecond', guardian, EXACT)
      await exactly(atEnd)
      await expect(
        unregister(f, 'atitsend', guardian, EXACT),
      ).toBeRevertedWithCustomErrorFrom(f.baseRegistrar, 'DisputePeriodOver')
      for (const label of ['byguardian', 'byadmin', 'lastsecond'])
        expect(await f.baseRegistrar.read.nameExpires([id(label)])).toBe(0n)
      expect(await f.baseRegistrar.read.ownerOf([id('atitsend')])).toBe(
        getAddress(alice.address),
      )
    })

    it('ends the registration, its records and its subnames at once', async () => {
      const f = await load()
      await sponsored(f, 'disputed', { resolver: f.resolver.address })
      await f.resolver.write.setText([node('disputed'), KEY, 'https://smp/alice'], {
        account: alice,
      })
      const sub = await withSubname(f, 'disputed')
      await expect(unregister(f, 'disputed'))
        .toEmitEventFrom(f.baseRegistrar, 'NameUnregistered')
        .withArgs({ id: id('disputed') })
      expect(await f.baseRegistrar.read.nameExpires([id('disputed')])).toBe(0n)
      expect(await f.baseRegistrar.read.disputeUntil([id('disputed')])).toBe(0n)
      expect(await f.baseRegistrar.read.available([id('disputed')])).toBe(true)
      expect(await f.controller.read.available(['disputed'])).toBe(true)
      await expect(
        f.baseRegistrar.read.ownerOf([id('disputed')]),
      ).toBeRevertedWithoutReason()
      expect(await f.ens.read.owner([node('disputed')])).toBe(zeroAddress)
      expect(await f.ens.read.resolver([node('disputed')])).toBe(zeroAddress)
      expect(await f.resolver.read.text([node('disputed'), KEY])).toBe('')
      expect(await f.subnameRegistrar.read.ownerOf([sub])).toBe(zeroAddress)
      expect(await f.subnameRegistrar.read.expiryOf([node('disputed')])).toBe(0n)
      await f.subnameRegistrar.write.purge([node('disputed'), [labelhash('pay')]], {
        account: carol,
      })
      expect(
        await f.subnameRegistrar.read.childrenLength([node('disputed')]),
      ).toBe(0n)
      await expect(
        f.resolver.write.setText([node('disputed'), KEY, 'https://smp/again'], {
          account: alice,
        }),
      ).toBeRevertedWithoutReason()
      await expect(unregister(f, 'disputed')).toBeRevertedWithCustomErrorFrom(
        f.baseRegistrar,
        'DisputePeriodOver',
      )
    })

    it('refuses a claim and a renewal of an unregistered name', async () => {
      const f = await load()
      await sponsored(f, 'nomoreclaim')
      await f.baseRegistrar.write.approve([bob.address, id('nomoreclaim')], {
        account: alice,
      })
      await acceptGeneralTermsForClaim(
        connection,
        f.baseRegistrar,
        id('nomoreclaim'),
        alice.address,
        { account: bob },
      )
      await unregister(f, 'nomoreclaim')
      await expect(
        f.baseRegistrar.write.transferFrom(
          [alice.address, bob.address, id('nomoreclaim')],
          { account: bob },
        ),
      ).toBeRevertedWithoutReason()
      await acceptGeneralTermsForRenewal(connection, f.controller, 'nomoreclaim', YEAR, {
        account: alice,
      })
      await expect(
        f.controller.write.renew(['nomoreclaim', YEAR, zeroHash], {
          account: alice,
          value: YEAR_PRICE_USD,
        }),
      ).toBeRevertedWithoutReason()
    })

    it('lets anyone register the name again at once, without the old subnames and records', async () => {
      const f = await load()
      await sponsored(f, 'freedname', { resolver: f.resolver.address })
      await f.resolver.write.setText([node('freedname'), KEY, 'https://smp/alice'], {
        account: alice,
      })
      const sub = await withSubname(f, 'freedname')
      await unregister(f, 'freedname')
      await paid(f, 'freedname', bob)
      expect(await f.baseRegistrar.read.ownerOf([id('freedname')])).toBe(
        getAddress(bob.address),
      )
      expect(await f.baseRegistrar.read.balanceOf([alice.address])).toBe(0n)
      expect(await f.baseRegistrar.read.disputeUntil([id('freedname')])).toBe(0n)
      expect(await f.subnameRegistrar.read.ownerOf([sub])).toBe(zeroAddress)
      expect(await f.resolver.read.text([node('freedname'), KEY])).toBe('')
    })

    it('writes a new dispute end at a sponsored registration after an unregistration', async () => {
      const f = await load()
      await sponsored(f, 'secondsale')
      await unregister(f, 'secondsale')
      const until = await sponsored(f, 'secondsale', {
        holder: bob,
        days: MAX_DISPUTE_DAYS,
      })
      expect(await f.baseRegistrar.read.disputeUntil([id('secondsale')])).toBe(until)
    })

    it('takes the name from a recipient of a claim in the dispute period', async () => {
      const f = await load()
      await sponsored(f, 'soldearly')
      await f.baseRegistrar.write.approve([bob.address, id('soldearly')], {
        account: alice,
      })
      await acceptGeneralTermsForClaim(
        connection,
        f.baseRegistrar,
        id('soldearly'),
        alice.address,
        { account: bob },
      )
      await f.baseRegistrar.write.transferFrom(
        [alice.address, bob.address, id('soldearly')],
        { account: bob },
      )
      await unregister(f, 'soldearly')
      expect(await f.baseRegistrar.read.nameExpires([id('soldearly')])).toBe(0n)
      expect(await f.ens.read.owner([node('soldearly')])).toBe(zeroAddress)
    })

    it('refuses a renewal on both paths until the dispute period ends', async () => {
      const f = await load()
      const until = await sponsored(f, 'renewlater')
      await acceptGeneralTermsForRenewal(connection, f.controller, 'renewlater', YEAR, {
        account: alice,
      })
      await expect(
        f.sponsor.write.renewWithCredit(['renewlater', YEAR, zeroHash, alice.address], {
          account: registrar,
        }),
      ).toBeRevertedWithCustomErrorFrom(f.controller, 'DisputePeriodNotOver')
      await exactly(until - 1n)
      await expect(
        f.controller.write.renew(['renewlater', YEAR, zeroHash], {
          account: alice,
          value: YEAR_PRICE_USD,
          ...EXACT,
        }),
      ).toBeRevertedWithCustomError('DisputePeriodNotOver')
      await exactly(until)
      await f.controller.write.renew(['renewlater', YEAR, zeroHash], {
        account: alice,
        value: YEAR_PRICE_USD,
        ...EXACT,
      })
      expect(await f.baseRegistrar.read.nameExpires([id('renewlater')])).toBe(
        until - MIN_DISPUTE_DAYS * DAY + MIN_REGISTRATION + YEAR,
      )
    })

    it('is made on the registrar by a registrar controller only', async () => {
      const f = await load()
      await sponsored(f, 'directcall')
      for (const account of [owner, guardian, alice])
        await expect(
          f.baseRegistrar.write.unregister([id('directcall')], { account }),
        ).toBeRevertedWithoutReason()
      expect(await f.baseRegistrar.read.ownerOf([id('directcall')])).toBe(
        getAddress(alice.address),
      )
    })
  })
})
