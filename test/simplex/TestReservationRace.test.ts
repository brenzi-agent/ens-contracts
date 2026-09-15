import hre from 'hardhat'
import { encodeFunctionData, labelhash, zeroAddress, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  MIN_REGISTRATION,
  registration,
  yearPriceUSD,
} from './fixtures/namesV2.js'

const TRADEMARK = 2 // SimplexController.Reason.Trademark

const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, aliceClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const squatter = aliceClient.account

// The production deployment sets minCommitmentAge to 60s; the shared fixture
// uses 0 for convenience, so this suite deploys its own with the real value.
const MIN_COMMITMENT_AGE = 60n

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  const impl = await connection.viem.deployContract('SimplexController', [])
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: 'initialize',
    args: [
      f.baseRegistrar.address,
      f.priceOracle.address,
      MIN_COMMITMENT_AGE,
      86400n,
      f.ens.address,
      {
        tldNode: (await import('viem')).namehash('simplex'),
        tldSuffix: '.simplex',
        minCharLength: 6,
        smpxNft: zeroAddress,
        nftGateEnabled: false,
      },
      owner.address,
    ],
  })
  const proxy = await connection.viem.deployContract('SimplexControllerProxy', [
    impl.address,
    initData,
  ])
  const controller = await connection.viem.getContractAt(
    'SimplexController',
    proxy.address,
  )
  await f.baseRegistrar.write.addController([controller.address])
  await controller.write.setBeneficiary([guardian.address], { account: owner })
  await controller.write.setPublicSalesOpen([true], { account: owner })
  await controller.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  return { ...f, controller }
}
const load = () => connection.networkHelpers.loadFixture(fixture)

/**
 * Reserving is defensive and must not be beatable by whoever reads the pending
 * transaction. The asymmetry that protects it: `addReservedNames` is a single
 * atomic call with no commit/reveal, while every registration path must present
 * a commitment already aged `minCommitmentAge`. So an attacker who first learns
 * the name from the guardian's pending transaction cannot register it — their
 * commitment cannot mature before the reservation mines.
 */
describe('reservation vs. registration race', () => {
  it('a squatter who commits on seeing the reservation cannot land in time', async () => {
    const { controller } = await load()
    const reg = registration('targetname', squatter.address)

    // the squatter reads the guardian's pending addReservedNames and commits
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: squatter },
    )
    // the reservation mines in the next block, long before 60s elapse
    await controller.write.addReservedNames([['targetname'], TRADEMARK], {
      account: guardian,
    })

    // even after waiting out the full commitment age, the name is now reserved
    await connection.networkHelpers.time.increase(Number(MIN_COMMITMENT_AGE) + 1)
    await expect(
      controller.write.register([reg], {
        account: squatter,
        value: 2n * yearPriceUSD(10),
      }),
    ).toBeRevertedWithCustomError('NameReserved')
  })

  it('the commitment age is what does it — an aged commitment is refused just the same', async () => {
    const { controller } = await load()
    const reg = registration('warmtarget', squatter.address)

    // a speculative squatter pre-commits and lets it mature *before* any
    // reservation exists; this is the strongest case they can construct
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: squatter },
    )
    await connection.networkHelpers.time.increase(Number(MIN_COMMITMENT_AGE) + 1)

    // the reservation still wins, because it is checked at registration time
    await controller.write.addReservedNames([['warmtarget'], TRADEMARK], {
      account: guardian,
    })
    await expect(
      controller.write.register([reg], {
        account: squatter,
        value: 2n * yearPriceUSD(10),
      }),
    ).toBeRevertedWithCustomError('NameReserved')
  })

  it('an immature commitment is refused, which is the property the race relies on', async () => {
    const { controller } = await load()
    const reg = registration('freshname', squatter.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: squatter },
    )
    await expect(
      controller.write.register([reg], {
        account: squatter,
        value: 2n * yearPriceUSD(9),
      }),
    ).toBeRevertedWithCustomError('CommitmentTooNew')
  })

  it('the sponsored path is bound by the same commitment age', async () => {
    const { controller } = await load()
    const reg = registration('sponsored', squatter.address)
    await controller.write.commit(
      [await controller.read.makeCommitment([reg])],
      { account: registrar },
    )
    await expect(
      controller.write.registerWithCredit([reg], { account: registrar }),
    ).toBeRevertedWithCustomError('CommitmentTooNew')
  })

  it('registerReserved needs no commitment, so the owner is never in the race', async () => {
    const { controller, baseRegistrar } = await load()
    await controller.write.addReservedNames([['ownerhands'], TRADEMARK], {
      account: guardian,
    })
    await controller.write.registerReserved(
      ['ownerhands', squatter.address, MIN_REGISTRATION],
      { account: owner },
    )
    expect(
      (
        await baseRegistrar.read.ownerOf([BigInt(labelhash('ownerhands'))])
      ).toLowerCase(),
    ).toBe(squatter.address.toLowerCase())
  })
})
