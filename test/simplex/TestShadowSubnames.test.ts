import hre from 'hardhat'
import { encodePacked, keccak256, labelhash, namehash, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  acceptGeneralTermsForClaim,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  node,
  registerWithCredit,
  registration,
} from './fixtures/namesV2.js'

/**
 * H2. A 2LD owner owns the registry node, so they can call
 * `ens.setSubnodeOwner` directly and create a subname the SubnameRegistrar
 * never sees. Such a node is not soulbound, is not indexed, and its generation
 * is never bumped — so selling the 2LD does not move it.
 *
 * These tests pin what is actually true, because the difference between
 * "unrecoverable theft" and "recoverable but invisible" decides whether this
 * needs a contract change or a buyer-side check.
 */
const connection = await hre.network.connect()
const [ownerClient, guardianClient, registrarClient, sellerClient, buyerClient] =
  await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const seller = sellerClient.account
const buyer = buyerClient.account

const NAME = 'shadowed'
const NODE = node(NAME)
const TOKEN = BigInt(labelhash(NAME))
const SHADOW = keccak256(
  encodePacked(['bytes32', 'bytes32'], [NODE, labelhash('pay')]),
)

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  const reg = registration(NAME, seller.address, { resolver: f.resolver.address })
  await commitUnderGeneralTerms(connection, f.controller, reg, { account: seller })
  await registerWithCredit(connection, f.sponsor, reg, { account: registrar })
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

describe('shadow subnames (H2)', () => {
  it('a 2LD owner can create a subnode the registrar never tracks', async () => {
    const { ens, subnameRegistrar } = await load()
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), seller.address], {
      account: seller,
    })
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      seller.address.toLowerCase(),
    )
    // The registrar has no record of it: not indexed, no parent, no owner.
    expect(await subnameRegistrar.read.parentOf([SHADOW])).toBe(
      `0x${'00'.repeat(32)}`,
    )
    expect(await subnameRegistrar.read.childIndexed([SHADOW])).toBe(false)
    expect(await subnameRegistrar.read.ownerOf([BigInt(SHADOW)])).toBe(
      zeroAddress,
    )
  })

  it('selling the 2LD does not move it — the seller keeps the subname', async () => {
    const { ens, baseRegistrar } = await load()
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), seller.address], {
      account: seller,
    })
    await baseRegistrar.write.approve([buyer.address, TOKEN], {
      account: seller,
    })
    await acceptGeneralTermsForClaim(connection, baseRegistrar, TOKEN, seller.address, {
      account: buyer,
    })
    await baseRegistrar.write.transferFrom(
      [seller.address, buyer.address, TOKEN],
      { account: buyer },
    )
    // Auto-reclaim moved the 2LD node itself...
    expect((await ens.read.owner([NODE])).toLowerCase()).toBe(
      buyer.address.toLowerCase(),
    )
    // ...but not the shadow subnode underneath it.
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      seller.address.toLowerCase(),
    )
  })

  it('but the buyer can always take it back, because they own the parent', async () => {
    const { ens, baseRegistrar } = await load()
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), seller.address], {
      account: seller,
    })
    await baseRegistrar.write.approve([buyer.address, TOKEN], {
      account: seller,
    })
    await acceptGeneralTermsForClaim(connection, baseRegistrar, TOKEN, seller.address, {
      account: buyer,
    })
    await baseRegistrar.write.transferFrom(
      [seller.address, buyer.address, TOKEN],
      { account: buyer },
    )
    // This is the whole reason H2 is a disclosure problem and not a theft one:
    // ENSRegistry.setSubnodeOwner is authorised against the PARENT, so the new
    // holder can overwrite any subnode under their name unilaterally.
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), buyer.address], {
      account: buyer,
    })
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      buyer.address.toLowerCase(),
    )
    // And the seller can no longer touch it.
    await expect(
      ens.write.setOwner([SHADOW, seller.address], { account: seller }),
    ).rejects.toThrow()
  })

  it('a tracked subname pulled out of the registrar is recoverable too', async () => {
    const { ens, subnameRegistrar, baseRegistrar } = await load()
    await ens.write.setApprovalForAll([subnameRegistrar.address, true], {
      account: seller,
    })
    await subnameRegistrar.write.createSubname([NODE, 'pay'], {
      account: seller,
    })
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      subnameRegistrar.address.toLowerCase(),
    )

    // The 2LD owner owns the parent, so they can yank a tracked subname out of
    // the registrar and hold it directly — the soulbinding is enforced by who
    // owns the registry node, and they can change that.
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), seller.address], {
      account: seller,
    })
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      seller.address.toLowerCase(),
    )

    await baseRegistrar.write.approve([buyer.address, TOKEN], {
      account: seller,
    })
    await acceptGeneralTermsForClaim(connection, baseRegistrar, TOKEN, seller.address, {
      account: buyer,
    })
    await baseRegistrar.write.transferFrom(
      [seller.address, buyer.address, TOKEN],
      { account: buyer },
    )
    // Still recoverable: the buyer owns the parent.
    await ens.write.setSubnodeOwner([NODE, labelhash('pay'), buyer.address], {
      account: buyer,
    })
    expect((await ens.read.owner([SHADOW])).toLowerCase()).toBe(
      buyer.address.toLowerCase(),
    )
  })
})
