import hre from 'hardhat'
import { parseEther, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2 } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const testClient = await connection.viem.getTestClient()
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
