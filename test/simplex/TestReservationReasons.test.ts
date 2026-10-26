import hre from 'hardhat'
import { labelhash } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, Reason } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const [ownerClient, guardianClient] = await connection.viem.getWalletClients()
const publicClient = await connection.viem.getPublicClient()
const owner = ownerClient.account
const guardian = guardianClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

/**
 * `Reason.None` is both "no reason" and "not reserved", which is what lets one
 * mapping answer both and `delete` keep working. The wording a user reads is
 * client-side, so nothing here asserts on English.
 */
describe('reservation reasons', () => {
  it('stores the reason it was given', async () => {
    const { namePolicy } = await load()
    await namePolicy.write.addReservedNames([['brandheld'], Reason.Trademark], {
      account: owner,
    })
    await expect(
      namePolicy.read.reservedNames([labelhash('brandheld')]),
    ).resolves.toBe(Reason.Trademark)
  })

  it('holds a name against every reason, not just the first', async () => {
    const { controller, namePolicy } = await load()
    const cases = [
      ['tm', Reason.Trademark],
      ['ours', Reason.Internal],
      ['civic', Reason.Community],
    ] as const
    for (const [label, reason] of cases) {
      await namePolicy.write.addReservedNames([[label], reason], {
        account: owner,
      })
      await expect(
        namePolicy.read.reservedNames([labelhash(label)]),
      ).resolves.toBe(reason)
      // every reason reserves — availability must not depend on which one
      await expect(controller.read.available([label])).resolves.toBe(false)
    }
  })

  it('refuses Reason.None, which would silently unreserve', async () => {
    const { namePolicy } = await load()
    await expect(
      namePolicy.write.addReservedNames([['nothingness'], Reason.None], {
        account: owner,
      }),
    ).rejects.toThrow()
    await expect(
      namePolicy.read.reservedNames([labelhash('nothingness')]),
    ).resolves.toBe(Reason.None)
  })

  it('reclassifies without unreserving, so no gap opens', async () => {
    const { controller, namePolicy } = await load()
    await namePolicy.write.addReservedNames([['reclassify'], Reason.Internal], {
      account: owner,
    })
    await namePolicy.write.setReservationReason(
      [['reclassify'], Reason.Community],
      { account: owner },
    )
    await expect(
      namePolicy.read.reservedNames([labelhash('reclassify')]),
    ).resolves.toBe(Reason.Community)
    // the point of the function: it never passed through unreserved
    await expect(controller.read.available(['reclassify'])).resolves.toBe(false)
  })

  it('will not reclassify a name that is not reserved', async () => {
    const { namePolicy } = await load()
    await expect(
      namePolicy.write.setReservationReason([['never'], Reason.Trademark], {
        account: owner,
      }),
    ).rejects.toThrow()
  })

  it('removing clears the reason back to None', async () => {
    const { controller, namePolicy } = await load()
    await namePolicy.write.addReservedNames([['temporary'], Reason.Community], {
      account: owner,
    })
    await namePolicy.write.removeReservedNames([['temporary']], {
      account: owner,
    })
    await expect(
      namePolicy.read.reservedNames([labelhash('temporary')]),
    ).resolves.toBe(Reason.None)
    await expect(controller.read.available(['temporary'])).resolves.toBe(true)
  })

  it('carries the reason in the event indexers read', async () => {
    const { namePolicy } = await load()
    const hash = await namePolicy.write.addReservedNames(
      [['indexed'], Reason.Community],
      { account: owner },
    )
    await publicClient.waitForTransactionReceipt({ hash })
    const logs = await namePolicy.getEvents.ReservedNameAdded()
    expect(logs.at(-1)?.args).toMatchObject({
      name: 'indexed',
      reason: Reason.Community,
    })
  })
})
