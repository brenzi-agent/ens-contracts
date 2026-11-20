import hre from 'hardhat'
import { pad, toHex } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2, storageLayout } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
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

// The controller's own variables follow ~150 slots of OpenZeppelin upgradeable gaps.
const SCAN = 400

async function snapshot(address: `0x${string}`) {
  const slots: string[] = []
  for (let i = 0; i < SCAN; i++) {
    slots.push(
      (await publicClient.getStorageAt({ address, slot: pad(toHex(i)) })) ?? '0x',
    )
  }
  return slots
}

function changed(before: string[], after: string[]) {
  const out: number[] = []
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push(i)
  return out
}

/**
 * The controller is upgradeable until its ProxyAdmin is renounced, so its
 * storage must stay append-only and the new governance state must pack as
 * designed: defaultResolver with publicSalesOpen. A reordering that would
 * silently corrupt a deployed proxy is detected by these assertions.
 */
describe('controller storage layout', () => {
  it('the beneficiary sits in its own slot', async () => {
    const { controller } = await load()
    const before = await snapshot(controller.address)
    await controller.write.setBeneficiary([alice.address], {
      account: guardian,
    })
    const after = await snapshot(controller.address)

    const touched = changed(before, after)
    expect(touched).toHaveLength(1)
    expect(after[touched[0]]).toBe(pad(alice.address).toLowerCase())
    const layout = await storageLayout(hre.artifacts, 'SimplexController')
    expect(
      layout
        .filter(({ slot }) => slot === BigInt(touched[0]))
        .map(({ label }) => label),
    ).toEqual(['beneficiary'])
  })

  it('defaultResolver and publicSalesOpen share one slot', async () => {
    const { controller, resolver } = await load()
    const before = await snapshot(controller.address)
    await controller.write.setPublicSalesOpen([true], { account: owner })
    const after = await snapshot(controller.address)

    const touched = changed(before, after)
    expect(touched).toHaveLength(1)
    const word = after[touched[0]]
    expect(word.toLowerCase()).toContain(resolver.address.slice(2).toLowerCase())
  })

  it('the three new slots sit after every pre-existing variable', async () => {
    const { controller, resolver } = await load()
    // find the slot each new variable occupies
    const base = await snapshot(controller.address)
    await controller.write.setPublicSalesOpen([true], { account: owner })
    const [resolverSlot] = changed(base, await snapshot(controller.address))

    const before = await snapshot(controller.address)
    await controller.write.setBeneficiary([alice.address], {
      account: guardian,
    })
    const [beneficiarySlot] = changed(
      before,
      await snapshot(controller.address),
    )

    // beneficiary, then the sponsor, then defaultResolver/publicSalesOpen
    expect(resolverSlot - beneficiarySlot).toBe(2)

    // and the reentrancy guard, the last pre-existing variable, sits just before
    const guardSlot = beneficiarySlot - 1
    const guard = await publicClient.getStorageAt({
      address: controller.address,
      slot: pad(toHex(guardSlot)),
    })
    expect(BigInt(guard!)).toBe(1n) // _NOT_ENTERED
  })

  it('the reverse-registrar slots are reserved, not removed', async () => {
    const { controller, priceOracle } = await load()
    const read = async (i: number) =>
      ((await publicClient.getStorageAt({
        address: controller.address,
        slot: pad(toHex(i)),
      })) ?? '0x').toLowerCase()

    // Reverse resolution is gone, but its two slots are kept so nothing below
    // them shifts and so the feature can be reintroduced without a migration.
    // maxCommitmentAge is 86400 in the fixture; prices holds the oracle address.
    const oracle = priceOracle.address.slice(2).toLowerCase()
    let maxSlot = -1
    let pricesSlot = -1
    for (let i = 0; i < SCAN; i++) {
      const w = await read(i)
      if (maxSlot < 0 && BigInt(w) === 86400n) maxSlot = i
      if (pricesSlot < 0 && w.endsWith(oracle)) pricesSlot = i
    }
    expect(maxSlot).toBeGreaterThan(-1)
    expect(pricesSlot - maxSlot).toBe(3)
    expect(BigInt(await read(maxSlot + 1))).toBe(0n)
    expect(BigInt(await read(maxSlot + 2))).toBe(0n)
  })

  it('wasDefaultResolver is a mapping, so it costs no linear slot', async () => {
    const { controller, resolver } = await load()
    const before = await snapshot(controller.address)
    await controller.write.setDefaultResolver([resolver.address], {
      account: owner,
    })
    const after = await snapshot(controller.address)
    // defaultResolver itself is a linear slot and may change; the set must not
    // add a second one, or the appended mapping would have eaten into the gap
    // twice over.
    expect(changed(before, after).length).toBeLessThanOrEqual(1)
    expect(await controller.read.wasDefaultResolver([resolver.address])).toBe(
      true,
    )
  })

  it('the name policy sits after wasDefaultResolver', async () => {
    const { controller, namePolicyImplementation } = await load()
    const base = await snapshot(controller.address)
    await controller.write.setPublicSalesOpen([true], { account: owner })
    const [resolverSlot] = changed(base, await snapshot(controller.address))

    const secondPolicy = await connection.viem.deployContract('SimplexNamePolicyProxy', [
      namePolicyImplementation.address,
      '0x',
    ])
    const before = await snapshot(controller.address)
    await controller.write.setNamePolicy([secondPolicy.address], { account: owner })
    const after = await snapshot(controller.address)
    expect(changed(before, after)).toEqual([resolverSlot + 2])
    expect(after[resolverSlot + 2]).toBe(pad(secondPolicy.address).toLowerCase())
  })

  it('the sponsor sits in its own slot', async () => {
    const { controller } = await load()
    const before = await snapshot(controller.address)
    await controller.write.setSponsor([alice.address], {
      account: owner,
    })
    const after = await snapshot(controller.address)
    const touched = changed(before, after)
    expect(touched).toHaveLength(1)
    expect(after[touched[0]]).toBe(pad(alice.address).toLowerCase())
  })
})
