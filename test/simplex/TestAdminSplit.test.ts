import hre from 'hardhat'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, YEAR } from './fixtures/namesV2.js'

const TRADEMARK = 2 // SimplexNamePolicy.Reason.Trademark

const connection = await hre.network.connect()
const [ownerClient, guardianClient, , aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const alice = aliceClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const OWNABLE = 'Ownable: caller is not the owner'

/**
 * The custody model splits controls by direction: the restrictive direction is
 * held by the guardian so it can be used immediately, the permissive direction
 * by the owner so it is visible before it lands. These tests are what stop that
 * split drifting out of the contract.
 */
describe('admin split', () => {
  describe('restrictive: owner and guardian both', () => {
    it('addReservedNames', async () => {
      const { namePolicy } = await load()
      await namePolicy.write.addReservedNames([['byowner'], TRADEMARK], { account: owner })
      await namePolicy.write.addReservedNames([['byguard'], TRADEMARK], {
        account: guardian,
      })
      await expect(
        namePolicy.write.addReservedNames([['bynobody'], TRADEMARK], { account: alice }),
      ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
    })

    it('setPublicSalesOpen', async () => {
      const { controller } = await load()
      await controller.write.setPublicSalesOpen([true], { account: owner })
      await controller.write.setPublicSalesOpen([false], { account: guardian })
      await expect(
        controller.write.setPublicSalesOpen([true], { account: alice }),
      ).toBeRevertedWithCustomError('NotOwnerOrBeneficiary')
    })
  })

  describe('permissive: owner only, guardian rejected', () => {
    it('removeReservedNames', async () => {
      const { namePolicy } = await load()
      await namePolicy.write.addReservedNames([['releaseme'], TRADEMARK], {
        account: owner,
      })
      await expect(
        namePolicy.write.removeReservedNames([['releaseme']], {
          account: guardian,
        }),
      ).toBeRevertedWithCustomError('NotOwner')
      await namePolicy.write.removeReservedNames([['releaseme']], {
        account: owner,
      })
    })

    it('registerReserved', async () => {
      const { namePolicy } = await load()
      await namePolicy.write.addReservedNames([['handitover'], TRADEMARK], {
        account: owner,
      })
      await expect(
        namePolicy.write.registerReserved(
          ['handitover', alice.address, YEAR],
          { account: guardian },
        ),
      ).toBeRevertedWithCustomError('NotOwner')
    })

    it('setDefaultResolver, setSponsor, setMinCharLength, setPriceOracle, freeze', async () => {
      const { controller, dummyOracle } = await load()
      await expect(
        controller.write.setDefaultResolver([alice.address], {
          account: guardian,
        }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        controller.write.setSponsor([alice.address], { account: guardian }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        controller.write.setMinCharLength([5], { account: guardian }),
      ).toBeRevertedWithString(OWNABLE)
      const oracle = await connection.viem.deployContract('StablePriceOracle', [
        dummyOracle.address,
        [0n, 0n, 0n, 0n, 0n],
      ])
      await expect(
        controller.write.setPriceOracle([oracle.address], {
          account: guardian,
        }),
      ).toBeRevertedWithString(OWNABLE)
      await expect(
        controller.write.freeze({ account: guardian }),
      ).toBeRevertedWithString(OWNABLE)
    })
  })

  describe('guardian only, owner rejected', () => {
    it('setRegistrarAllowance and setBeneficiary', async () => {
      const { controller, sponsor } = await load()
      await expect(
        sponsor.write.setRegistrarAllowance([alice.address, 1n], {
          account: owner,
        }),
      ).toBeRevertedWithCustomError('NotBeneficiary')
      await expect(
        controller.write.setBeneficiary([alice.address], { account: owner }),
      ).toBeRevertedWithCustomError('NotBeneficiary')

      await sponsor.write.setRegistrarAllowance([alice.address, 1n], {
        account: guardian,
      })
      expect(await sponsor.read.registrarAllowance([alice.address])).toBe(1n)
    })
  })
})
