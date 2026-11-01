import hre from 'hardhat'
import { labelhash, zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  MIN_REGISTRATION,
  node,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark
const GRACE_PERIOD = 90n * DAY

const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, brandClient, claimantClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const brand = brandClient.account
const claimant = claimantClient.account
const registrar = registrarClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const renewBrandname = (controller: any) =>
  controller.write.renew(['brandname', YEAR, zeroHash], {
    account: brand,
    value: YEAR_PRICE_USD,
  })

/**
 * `registerReserved` is how a brand receives its name. `setSubnodeOwner` alone
 * sets an owner but not a resolver, so without the resolver path the name would
 * not resolve at all and the brand would need ETH to fix it.
 */
describe('no reverse resolution', () => {
  it('refuses any registration carrying a reverse bit, on both paths', async () => {
    const { controller } = await load()
    for (const bit of [1, 2, 3]) {
      await expect(
        controller.read.makeCommitment([
          {
            label: 'reversebit',
            owner: brand.address,
            duration: MIN_REGISTRATION,
            secret: `0x${'00'.repeat(32)}` as `0x${string}`,
            resolver: zeroAddress,
            data: [] as `0x${string}`[],
            reverseRecord: bit,
            referrer: `0x${'00'.repeat(32)}` as `0x${string}`,
          },
        ]),
      ).toBeRevertedWithCustomError('ReverseRecordNotSupported')
    }
  })

  it('the controller holds no reverse registrar at all', async () => {
    const { controller } = await load()
    // the storage slots and initializer arguments are gone, so there is nothing
    // to read; this asserts the ABI no longer carries them
    const names = (controller.abi as any[])
      .filter((e) => e.type === 'function')
      .map((e) => e.name)
    expect(names).not.toContain('reverseRegistrar')
    expect(names).not.toContain('defaultReverseRegistrar')
  })
})

describe('registerReserved', () => {
  it('gives the brand the token, the registry node and a working resolver', async () => {
    const { namePolicy, ens, baseRegistrar, resolver } = await load()
    await namePolicy.write.addReservedNames([['brandname'], TRADEMARK], { account: owner })
    await namePolicy.write.registerReserved(['brandname', brand.address, MIN_REGISTRATION], {
      account: owner,
    })

    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('brandname'))])
      ).toLowerCase(),
    ).toBe(brand.address.toLowerCase())
    expect((await ens.read.owner([node('brandname')])).toLowerCase()).toBe(
      brand.address.toLowerCase(),
    )
    expect((await ens.read.resolver([node('brandname')])).toLowerCase()).toBe(
      resolver.address.toLowerCase(),
    )
  })

  it('releases the reservation, so the brand renews like any holder', async () => {
    const { controller, namePolicy, baseRegistrar } = await load()
    await namePolicy.write.addReservedNames([['brandname'], TRADEMARK], { account: owner })
    await expect(
      namePolicy.write.registerReserved(['brandname', brand.address, MIN_REGISTRATION], {
        account: owner,
      }),
    )
      .toEmitEvent('ReservedNameRemoved')
      .withArgs({ name: 'brandname' })

    const id = BigInt(labelhash('brandname'))
    const before = await baseRegistrar.read.nameExpires([id])
    await renewBrandname(controller)
    expect(await baseRegistrar.read.nameExpires([id])).toBe(before + YEAR)
  })

  it('the brand can then have records relayed without ever holding ETH', async () => {
    const { namePolicy, resolver } = await load()
    await namePolicy.write.addReservedNames([['relayable'], TRADEMARK], { account: owner })
    await namePolicy.write.registerReserved(['relayable', brand.address, MIN_REGISTRATION], {
      account: owner,
    })
    expect((await resolver.read.relayedSigner([node('relayable')])).toLowerCase()).toBe(
      brand.address.toLowerCase(),
    )
  })

  it('refuses a name that is not reserved', async () => {
    const { namePolicy } = await load()
    await expect(
      namePolicy.write.registerReserved(['unreserved', brand.address, MIN_REGISTRATION], {
        account: owner,
      }),
    ).toBeRevertedWithCustomError('NameNotReserved')
  })

  it('refuses a duration below the minimum', async () => {
    const { namePolicy } = await load()
    await namePolicy.write.addReservedNames([['tooshortterm'], TRADEMARK], {
      account: owner,
    })
    await expect(
      namePolicy.write.registerReserved(
        ['tooshortterm', brand.address, 27n * DAY],
        { account: owner },
      ),
    ).toBeRevertedWithCustomError('DurationTooShort')
  })

  it('is owner-only — the guardian may reserve but not hand out', async () => {
    const { namePolicy } = await load()
    await namePolicy.write.addReservedNames([['guardedname'], TRADEMARK], {
      account: guardian,
    })
    await expect(
      namePolicy.write.registerReserved(
        ['guardedname', brand.address, MIN_REGISTRATION],
        { account: guardian },
      ),
    ).toBeRevertedWithCustomError('NotOwner')
  })

  it('cannot take a name someone already holds', async () => {
    const { controller, namePolicy, baseRegistrar } = await load()
    await controller.write.setPublicSalesOpen([true], { account: owner })
    const reg = {
      label: 'alreadyheld',
      owner: brand.address,
      duration: MIN_REGISTRATION,
      secret: `0x${'00'.repeat(32)}` as `0x${string}`,
      resolver: zeroAddress,
      data: [] as `0x${string}`[],
      reverseRecord: 0,
      referrer: `0x${'00'.repeat(32)}` as `0x${string}`,
    }
    await commitUnderGeneralTerms(connection, controller, reg, { account: brand })
    await controller.write.register([reg], {
      account: brand,
      value: 10n ** 21n,
    })

    await namePolicy.write.addReservedNames([['alreadyheld'], TRADEMARK], {
      account: owner,
    })
    await expect(
      namePolicy.write.registerReserved(
        ['alreadyheld', owner.address, MIN_REGISTRATION],
        { account: owner },
      ),
    ).toBeRevertedWithoutReason()
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('alreadyheld'))])
      ).toLowerCase(),
    ).toBe(brand.address.toLowerCase())
  })

  it('degrades to a bare registration when no default resolver is set', async () => {
    const { controller, namePolicy, ens } = await load()
    await controller.write.setDefaultResolver([zeroAddress], { account: owner })
    await namePolicy.write.addReservedNames([['noresolver'], TRADEMARK], {
      account: owner,
    })
    await namePolicy.write.registerReserved(
      ['noresolver', brand.address, MIN_REGISTRATION],
      { account: owner },
    )
    // owner is set, but the name does not resolve — pinned so the behaviour is
    // a deliberate choice rather than a surprise
    expect((await ens.read.owner([node('noresolver')])).toLowerCase()).toBe(
      brand.address.toLowerCase(),
    )
    expect(BigInt(await ens.read.resolver([node('noresolver')]))).toBe(0n)
  })
})

describe('a disputed name', () => {
  const disputed = async () => {
    const f = await load()
    await f.namePolicy.write.addReservedNames([['brandname'], TRADEMARK], { account: owner })
    await f.namePolicy.write.registerReserved(['brandname', brand.address, MIN_REGISTRATION], {
      account: owner,
    })
    await f.namePolicy.write.addReservedNames([['brandname'], TRADEMARK], { account: guardian })
    return f
  }

  it('cannot be renewed once the guardian reserves it again', async () => {
    const { controller } = await disputed()
    await expect(renewBrandname(controller)).toBeRevertedWithCustomError('NameReserved')
  })

  it('cannot be renewed on credit either', async () => {
    const { controller, sponsor } = await disputed()
    await sponsor.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
      account: guardian,
    })
    await expect(
      sponsor.write.renewWithCredit(['brandname', YEAR, zeroHash], { account: registrar }),
    ).toBeRevertedWithCustomErrorFrom(controller, 'NameReserved')
  })

  it('can be renewed again once the admin releases it', async () => {
    const { controller, namePolicy, baseRegistrar } = await disputed()
    await namePolicy.write.removeReservedNames([['brandname']], { account: owner })
    const id = BigInt(labelhash('brandname'))
    const before = await baseRegistrar.read.nameExpires([id])
    await renewBrandname(controller)
    expect(await baseRegistrar.read.nameExpires([id])).toBe(before + YEAR)
  })

  it('stays reserved past its grace period, and the admin registers it to the claimant', async () => {
    const { controller, namePolicy, baseRegistrar } = await disputed()
    await connection.networkHelpers.time.increase(MIN_REGISTRATION + GRACE_PERIOD + 1n)
    expect(await controller.read.available(['brandname'])).toBe(false)

    await namePolicy.write.registerReserved(['brandname', claimant.address, MIN_REGISTRATION], {
      account: owner,
    })
    expect(
      (await baseRegistrar.read.ownerOf([BigInt(labelhash('brandname'))])).toLowerCase(),
    ).toBe(claimant.address.toLowerCase())
  })
})
