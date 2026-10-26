import hre from 'hardhat'
import { encodeFunctionData, parseEther, zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import { AMPLE_ALLOWANCE, deployNamesV2, MIN_REGISTRATION, registerWithCredit, registration, YEAR } from './fixtures/namesV2.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
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
  // `freeze` refuses while sales are closed, so every freeze test opens them first
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

describe('beneficiary', () => {
  it('is set by the owner while unset, and by itself afterwards', async () => {
    const { controller } = await load()
    expect((await controller.read.beneficiary()).toLowerCase()).toBe(
      guardian.address.toLowerCase(),
    )
    // the owner has spent its one chance
    await expect(
      controller.write.setBeneficiary([alice.address], { account: owner }),
    ).toBeRevertedWithCustomError('NotBeneficiary')
    // the beneficiary can hand it on
    await controller.write.setBeneficiary([alice.address], {
      account: guardian,
    })
    expect((await controller.read.beneficiary()).toLowerCase()).toBe(
      alice.address.toLowerCase(),
    )
  })

  it('rejects the zero address, so the role cannot be dropped by accident', async () => {
    const { controller } = await load()
    await expect(
      controller.write.setBeneficiary([zeroAddress], { account: guardian }),
    ).toBeRevertedWithCustomError('ZeroAddress')
  })

  it('withdraw pays the beneficiary, not the owner, and anyone may call it', async () => {
    const { controller } = await load()
    await testClient.setBalance({
      address: controller.address,
      value: parseEther('1'),
    })
    const before = await publicClient.getBalance({ address: guardian.address })
    await controller.write.withdraw({ account: alice })
    const after = await publicClient.getBalance({ address: guardian.address })
    expect(after - before).toBe(parseEther('1'))
    expect(await publicClient.getBalance({ address: controller.address })).toBe(
      0n,
    )
  })
})

describe('freeze', () => {
  it('blocks upgradeTo and upgradeToAndCall', async () => {
    const { controller } = await load()
    const next = await connection.viem.deployContract('SimplexController', [])

    await controller.write.freeze({ account: owner })

    await expect(
      controller.write.upgradeTo([next.address], { account: owner }),
    ).toBeRevertedWithCustomError('Frozen')
    await expect(
      controller.write.upgradeToAndCall([next.address, '0x'], {
        account: owner,
      }),
    ).toBeRevertedWithCustomError('Frozen')
  })

  it('fixes the sponsor, like the implementation', async () => {
    const { controller } = await load()
    await controller.write.setSponsor([alice.address], { account: owner })
    await controller.write.freeze({ account: owner })
    await expect(
      controller.write.setSponsor([owner.address], { account: owner }),
    ).toBeRevertedWithCustomError('Frozen')
  })

  it('refuses while no sponsor is set, so it cannot seal the sponsored path shut', async () => {
    const { controller } = await load()
    await controller.write.setSponsor([zeroAddress], { account: owner })
    await expect(
      controller.write.freeze({ account: owner }),
    ).toBeRevertedWithCustomError('ZeroAddress')
  })

  it('an upgrade succeeds before the freeze, so the block is the freeze and not the proxy', async () => {
    const { controller } = await load()
    const next = await connection.viem.deployContract('SimplexController', [])
    await controller.write.upgradeTo([next.address], { account: owner })
  })

  it('refuses while sales are closed, so a mis-ordered freeze cannot seal them shut', async () => {
    const { controller } = await load()
    await controller.write.setPublicSalesOpen([false], { account: guardian })
    await expect(
      controller.write.freeze({ account: owner }),
    ).toBeRevertedWithCustomError('PublicSalesClosed')
    expect(await controller.read.frozen()).toBe(false)

    // the switch still works, so the freeze is simply re-queued
    await controller.write.setPublicSalesOpen([true], { account: guardian })
    await controller.write.freeze({ account: owner })
    expect(await controller.read.frozen()).toBe(true)
  })

  it('the guardian pausing mid-timelock makes a queued freeze fail safe', async () => {
    const { controller, sponsor } = await load()
    // the owner's freeze is queued behind a timelock; before it executes the
    // guardian pauses to answer an incident on the payable path
    await controller.write.setPublicSalesOpen([false], { account: guardian })
    // the queued freeze now reverts rather than sealing sales closed forever
    await expect(
      controller.write.freeze({ account: owner }),
    ).toBeRevertedWithCustomError('PublicSalesClosed')
    // and everything else still works
    await sponsor.write.setRegistrarAllowance([registrar.address, 1n], {
      account: guardian,
    })
  })

  it('is one-way and owner-only', async () => {
    const { controller } = await load()
    await expect(
      controller.write.freeze({ account: guardian }),
    ).toBeRevertedWithString('Ownable: caller is not the owner')
    await expect(
      controller.write.freeze({ account: alice }),
    ).toBeRevertedWithString('Ownable: caller is not the owner')

    await controller.write.freeze({ account: owner })
    expect(await controller.read.frozen()).toBe(true)
    await expect(
      controller.write.freeze({ account: owner }),
    ).toBeRevertedWithCustomError('AlreadyFrozen')
  })

  it('leaves every other owner power working — this is a freeze, not a burn', async () => {
    const { controller, namePolicy, resolver, priceOracle, dummyOracle } = await load()
    await controller.write.freeze({ account: owner })

    // brand outreach continues with no horizon
    await namePolicy.write.addReservedNames([['brandish'], TRADEMARK], { account: owner })
    await namePolicy.write.registerReserved(['brandish', alice.address, MIN_REGISTRATION], {
      account: owner,
    })
    await namePolicy.write.removeReservedNames([['brandish']], {
      account: owner,
    })

    // and the namespace can survive its own price feed
    const replacement = await connection.viem.deployContract(
      'StablePriceOracle',
      [dummyOracle.address, [0n, 0n, 0n, 0n, 0n]],
    )
    await controller.write.setPriceOracle([replacement.address], {
      account: owner,
    })
    expect((await controller.read.prices()).toLowerCase()).toBe(
      replacement.address.toLowerCase(),
    )

    await controller.write.setMinCharLength([5], { account: owner })
    await controller.write.setDefaultResolver([resolver.address], {
      account: owner,
    })
  })

  it('leaves the guardian powers working too', async () => {
    const { controller, sponsor } = await load()
    await controller.write.freeze({ account: owner })
    await sponsor.write.setRegistrarAllowance(
      [registrar.address, 5n * 10n ** 18n],
      { account: guardian },
    )
    expect(await sponsor.read.registrarAllowance([registrar.address])).toBe(
      5n * 10n ** 18n,
    )
    await controller.write.setBeneficiary([alice.address], {
      account: guardian,
    })
  })

  it('leaves the sponsored path working end to end', async () => {
    const { controller, resolver, sponsor } = await load()
    await controller.write.freeze({ account: owner })

    const reg = registration('afterfreeze', alice.address, {
      resolver: resolver.address,
    })
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await registerWithCredit(connection, sponsor, reg, { account: registrar })
    await sponsor.write.renewWithCredit(['afterfreeze', YEAR, zeroHash], {
      account: registrar,
    })
  })
})
