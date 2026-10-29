import hre from 'hardhat'
import { labelhash, zeroAddress as zeroAddressLocal, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  MIN_REGISTRATION,
  node,
  registerWithCredit,
  registration,
  sponsorOf,
  YEAR,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark

const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, squatterClient, victimClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const squatter = squatterClient.account
const victim = victimClient.account

const GRACE = 90n * DAY
const KEY = 'simplex.contact'

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

async function sponsoredRegister(controller: any, label: string, to: `0x${string}`, resolver: `0x${string}`) {
  const reg = registration(label, to, { resolver })
  await commitUnderGeneralTerms(connection, controller, reg, { account: to })
  const sponsor = await sponsorOf(connection, controller)
  await registerWithCredit(connection, sponsor, reg, { account: registrar })
}

/**
 * Nothing clears a name's records when it expires: the registry keeps the
 * node's resolver pointer and the resolver keeps its data. In a messaging
 * namespace that is not cosmetic — a lapsed `simplex.contact` would keep
 * routing conversations to whoever owned the name last.
 */
describe('records do not survive re-registration', () => {
  it('still retires records after the default resolver is rotated', async () => {
    const { controller, resolver, baseRegistrar, ens, subnameRegistrar } =
      await load()

    // A name registered against the resolver that is default *today*.
    await sponsoredRegister(controller, 'rotated', squatter.address, resolver.address)
    await resolver.write.setText([node('rotated'), KEY, 'https://smp/squatter'], {
      account: squatter,
    })

    // Governance rotates the default to a freshly deployed resolver. The name
    // above still points at the old one — nothing rewrites live registrations.
    const newResolver = await connection.viem.deployContract('SimplexResolver', [
      ens.address,
      subnameRegistrar.address,
      controller.address,
      zeroAddressLocal,
    ])
    await controller.write.setDefaultResolver([newResolver.address], {
      account: owner,
    })

    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))
    await sponsoredRegister(controller, 'rotated', victim.address, newResolver.address)

    // Testing `stale == defaultResolver` would no-op here and hand the victim a
    // name still resolving to the squatter.
    expect(await resolver.read.text([node('rotated'), KEY])).toBe('')
  })

  it('a squatter cannot leave their contact link on a name they let lapse', async () => {
    const { controller, resolver, baseRegistrar } = await load()

    // the squatter takes the name and points it at themselves
    await sponsoredRegister(controller, 'contested', squatter.address, resolver.address)
    await resolver.write.setText(
      [node('contested'), KEY, 'https://smp/squatter'],
      { account: squatter },
    )
    expect(await resolver.read.text([node('contested'), KEY])).toBe(
      'https://smp/squatter',
    )

    // it lapses through the whole grace period
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))
    expect(
      await baseRegistrar.read.available([BigInt(labelhash('contested'))]),
    ).toBe(true)

    // the victim re-registers it
    await sponsoredRegister(controller, 'contested', victim.address, resolver.address)
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('contested'))])
      ).toLowerCase(),
    ).toBe(victim.address.toLowerCase())

    // and the squatter's link is gone, with no action required from the victim
    expect(await resolver.read.text([node('contested'), KEY])).toBe('')
  })

  it('clears every key at once, not just the one that was checked', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(controller, 'manykeys', squatter.address, resolver.address)
    for (const k of ['simplex.contact', 'simplex.channel', 'url', 'avatar']) {
      await resolver.write.setText([node('manykeys'), k, 'stale'], {
        account: squatter,
      })
    }
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))
    await sponsoredRegister(controller, 'manykeys', victim.address, resolver.address)

    for (const k of ['simplex.contact', 'simplex.channel', 'url', 'avatar']) {
      expect(await resolver.read.text([node('manykeys'), k])).toBe('')
    }
  })

  it('does not wipe the records the new registration itself sets', async () => {
    const { controller, resolver, sponsor } = await load()
    await sponsoredRegister(controller, 'withdata', squatter.address, resolver.address)
    await resolver.write.setText([node('withdata'), KEY, 'https://smp/old'], {
      account: squatter,
    })
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))

    const { encodeFunctionData } = await import('viem')
    const reg = registration('withdata', victim.address, {
      resolver: resolver.address,
      data: [
        encodeFunctionData({
          abi: resolver.abi,
          functionName: 'setText',
          args: [node('withdata'), KEY, 'https://smp/new'],
        }),
      ],
    })
    await commitUnderGeneralTerms(connection, controller, reg, { account: victim })
    await registerWithCredit(connection, sponsor, reg, { account: registrar })

    // the clear runs before the new records are written, so the new value stands
    expect(await resolver.read.text([node('withdata'), KEY])).toBe(
      'https://smp/new',
    )
  })

  it('a first registration is unaffected', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(controller, 'brandnew', victim.address, resolver.address)
    expect(await resolver.read.recordVersions([node('brandnew')])).toBe(0n)
  })

  it('registerReserved also retires the previous owner records', async () => {
    const { controller, namePolicy, resolver, ens } = await load()
    await sponsoredRegister(controller, 'brandname', squatter.address, resolver.address)
    await resolver.write.setText(
      [node('brandname'), KEY, 'https://smp/squatter'],
      { account: squatter },
    )
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))

    await namePolicy.write.addReservedNames([['brandname'], TRADEMARK], { account: owner })
    await namePolicy.write.registerReserved(
      ['brandname', victim.address, MIN_REGISTRATION],
      { account: owner },
    )
    expect((await ens.read.owner([node('brandname')])).toLowerCase()).toBe(
      victim.address.toLowerCase(),
    )
    expect(await resolver.read.text([node('brandname'), KEY])).toBe('')
  })

  it('the payable path clears too', async () => {
    const { controller, resolver } = await load()
    await sponsoredRegister(controller, 'paidagain', squatter.address, resolver.address)
    await resolver.write.setText([node('paidagain'), KEY, 'stale'], {
      account: squatter,
    })
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + GRACE + 1n))

    const reg = registration('paidagain', victim.address, {
      resolver: resolver.address,
    })
    await commitUnderGeneralTerms(connection, controller, reg, { account: victim })
    await controller.write.register([reg], {
      account: victim,
      value: 10n ** 21n,
    })
    expect(await resolver.read.text([node('paidagain'), KEY])).toBe('')
  })
})

/** Review fixes L1–L3: pricing and availability semantics. */
describe('renewal and availability semantics', () => {
  it('a renewal never owes the expired-name premium', async () => {
    const { controller, dummyOracle, sponsor } = await load()
    // a premium oracle: startPremium high, so a recently-expired name carries one
    const premiumOracle = await connection.viem.deployContract(
      'ExponentialPremiumPriceOracle',
      [
        dummyOracle.address,
        [0n, 0n, 0n, 0n, 0n, 317097919837n],
        100000000000000000000000000n,
        21n,
      ],
    )
    await controller.write.setPriceOracle([premiumOracle.address], {
      account: owner,
    })

    await sponsoredRegister(controller, 'renewprem', victim.address, zeroAddressLocal)
    // move to just past expiry, inside grace: registration would owe a premium,
    // renewal must not
    await connection.networkHelpers.time.increase(Number(MIN_REGISTRATION + 1n))

    const before = await sponsor.read.registrarAllowance([registrar.address])
    await sponsor.write.renewWithCredit(['renewprem', YEAR, zeroHash], {
      account: registrar,
    })
    const spent =
      before - (await sponsor.read.registrarAllowance([registrar.address]))

    const quote = await premiumOracle.read.priceUSD([
      'renewprem',
      0n,
      YEAR,
    ])
    expect(spent).toBe(quote.base)
  })

  it('available() reports a reserved name as unavailable', async () => {
    const { controller, namePolicy } = await load()
    expect(await controller.read.available(['freename'])).toBe(true)
    await namePolicy.write.addReservedNames([['freename'], TRADEMARK], { account: owner })
    expect(await controller.read.available(['freename'])).toBe(false)
  })

  it('initialize refuses a zero commitment age', async () => {
    const { baseRegistrar, priceOracle, ens } = await load()
    const { encodeFunctionData, namehash, zeroAddress } = await import('viem')
    const impl = await connection.viem.deployContract('SimplexController', [])
    const initData = encodeFunctionData({
      abi: impl.abi,
      functionName: 'initialize',
      args: [
        baseRegistrar.address,
        priceOracle.address,
        0n,
        86400n,
        ens.address,
        {
          tldNode: namehash('simplex'),
          tldSuffix: '.simplex',
          minCharLength: 6,
          smpxNft: zeroAddress,
          nftGateEnabled: false,
        },
        owner.address,
      ],
    })
    await expect(
      connection.viem.deployContract('SimplexControllerProxy', [
        impl.address,
        initData,
      ]),
    ).rejects.toThrow()
  })
})
