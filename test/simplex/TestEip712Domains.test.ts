import hre from 'hardhat'
import { hashDomain } from 'viem'
import { describe, expect, it } from 'vitest'

import { deployNamesV2 } from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [ownerClient, guardianClient] = await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account

async function fixture() {
  return deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
}
const load = () => connection.networkHelpers.loadFixture(fixture)

const expected = (name: string, verifyingContract: `0x${string}`, chainId: number) =>
  hashDomain({
    domain: { name, version: '1', chainId, verifyingContract },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  })

/**
 * Every signed intent in the stack is verified against one of these. A wrong
 * name, version, chain id or address would make signatures from one deployment
 * valid on another, so each is pinned against an independently computed hash
 * rather than against itself.
 */
describe('EIP-712 domains', () => {
  it('are distinct per contract and match the off-chain computation', async () => {
    const { ens, resolver, subnameRegistrar, baseRegistrar, sponsor, namePolicy } =
      await load()
    const chainId = await publicClient.getChainId()

    const domains = [
      ['SimplexENSRegistry', ens],
      ['SimplexResolver', resolver],
      ['SimplexSubnames', subnameRegistrar],
      ['SimplexNames', baseRegistrar],
      ['SimplexSponsor', sponsor],
      ['SimplexNamePolicy', namePolicy],
    ] as const

    const seen = new Set<string>()
    for (const [name, contract] of domains) {
      const onChain = await contract.read.DOMAIN_SEPARATOR()
      expect(onChain).toBe(expected(name, contract.address, chainId))
      seen.add(onChain)
    }
    expect(seen.size).toBe(domains.length)
  })

  it('bind to the contract address, so a second deployment cannot replay', async () => {
    const a = await load()
    const b = await connection.viem.deployContract('SimplexResolver', [
      a.ens.address,
      a.subnameRegistrar.address,
      a.controller.address,
      '0x0000000000000000000000000000000000000000',
    ])
    expect(await b.read.DOMAIN_SEPARATOR()).not.toBe(
      await a.resolver.read.DOMAIN_SEPARATOR(),
    )
  })
})
