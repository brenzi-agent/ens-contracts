import hre from 'hardhat'
import { zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  MIN_REGISTRATION,
  registerWithCredit,
  registration,
  sponsorOf,
  YEAR,
  YEAR_PRICE_USD,
} from './fixtures/namesV2.js'
import { DAY } from '../fixtures/constants.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark

const connection = await hre.network.connect()
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
  await f.sponsor.write.setRegistrarAllowance([registrar.address, AMPLE_ALLOWANCE], {
    account: guardian,
  })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function payableRegister(controller: any, label: string) {
  const reg = registration(label, alice.address)
  await commitUnderGeneralTerms(connection, controller, reg, { account: alice })
  return controller.write.register([reg], {
    account: alice,
    value: 2n * YEAR_PRICE_USD,
  })
}

async function creditedRegister(controller: any, label: string) {
  const reg = registration(label, alice.address)
  await commitUnderGeneralTerms(connection, controller, reg, { account: alice })
  const sponsor = await sponsorOf(connection, controller)
  return registerWithCredit(connection, sponsor, reg, { account: registrar })
}

describe('public sales switch', () => {
  it('ships closed', async () => {
    const { controller } = await load()
    expect(await controller.read.publicSalesOpen()).toBe(false)
  })

  it('the payable path reverts while closed and succeeds once open', async () => {
    const { controller } = await load()
    const reg = registration('closednow', alice.address)
    await commitUnderGeneralTerms(connection, controller, reg, { account: alice })
    // the matcher needs the raw write promise, so this is not wrapped in a helper
    await expect(
      controller.write.register([reg], {
        account: alice,
        value: 2n * YEAR_PRICE_USD,
      }),
    ).toBeRevertedWithCustomError('PublicSalesClosed')

    await controller.write.setPublicSalesOpen([true], { account: owner })
    await payableRegister(controller, 'opennow')
  })

  it('the credited path is exempt — this is how the investor window is served', async () => {
    const { controller } = await load()
    expect(await controller.read.publicSalesOpen()).toBe(false)
    await creditedRegister(controller, 'investor')
  })

  it('registerReserved is exempt', async () => {
    const { namePolicy } = await load()
    await namePolicy.write.addReservedNames([['reserved'], TRADEMARK], { account: owner })
    await namePolicy.write.registerReserved(['reserved', alice.address, MIN_REGISTRATION], {
      account: owner,
    })
  })

  it('renewal is exempt in both forms, so a pause never costs anyone a name', async () => {
    const { controller, sponsor } = await load()
    await creditedRegister(controller, 'renewany')
    expect(await controller.read.publicSalesOpen()).toBe(false)

    await controller.write.renew(['renewany', YEAR, zeroHash], {
      account: alice,
      value: YEAR_PRICE_USD,
    })
    await sponsor.write.renewWithCredit(['renewany', YEAR, zeroHash], {
      account: registrar,
    })
  })

  it('is two-way before the freeze', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([true], { account: owner })
    expect(await controller.read.publicSalesOpen()).toBe(true)
    await controller.write.setPublicSalesOpen([false], { account: owner })
    expect(await controller.read.publicSalesOpen()).toBe(false)
  })

  it('the guardian may pause immediately, without the owner', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([true], { account: guardian })
    expect(await controller.read.publicSalesOpen()).toBe(true)
    await controller.write.setPublicSalesOpen([false], { account: guardian })
    expect(await controller.read.publicSalesOpen()).toBe(false)
  })

  it('nobody else may flip it', async () => {
    const { controller } = await load()
    await expect(
      controller.write.setPublicSalesOpen([true], { account: alice }),
    ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
  })

  it('stops working at the freeze, locked in its current position', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([true], { account: owner })
    await controller.write.freeze({ account: owner })

    expect(await controller.read.publicSalesOpen()).toBe(true)
    await expect(
      controller.write.setPublicSalesOpen([false], { account: owner }),
    ).toBeRevertedWithCustomError('Frozen')
    await expect(
      controller.write.setPublicSalesOpen([false], { account: guardian }),
    ).toBeRevertedWithCustomError('Frozen')
    // and sales keep working, which is the point of checking it before freezing
    await payableRegister(controller, 'afterfrz')
  })
})
