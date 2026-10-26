import hre from 'hardhat'
import {
  decodeFunctionResult,
  encodeFunctionData,
  labelhash,
  namehash,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, it, expect } from 'vitest'

import { dnsEncodeName } from '../fixtures/dnsEncodeName.js'
import { PROFILE_ABI } from '../utils/resolutions.js'

// End-to-end resolution test standing in for the off-chain SNRC resolver
// (simplexmq scripts/resolver/snrc-resolve.py): it registers a 2LD and a
// subname, writes simplex.contact / simplex.channel text records, then looks
// them up through the UniversalResolver — the same ENSIP-10 path the dApp and
// any client use — and reconstructs the resolver's JSON shape. No Python, no
// running resolver: the on-chain lookup is the source of truth.

const connection = await hre.network.connect()
const [ownerClient, aliceClient] = await connection.viem.getWalletClients()
const ownerAccount = ownerClient.account // stands in as BaseRegistrar (onReregister)
const aliceAccount = aliceClient.account // holds the foobar.testing 2LD

const NAME = 'foobar.testing'
const SUBNAME = 'bar.foobar.testing'
const NAME_NODE = namehash(NAME)

// Separator joining the SMP-server URL list inside a simplex.contact /
// simplex.channel record. MUST match LINK_SEPARATOR in snrc-resolve.py and
// SIMPLEX_LINK_SEPARATOR in the dApp (ens-app-v3 src/constants/simplex.ts).
const LINK_SEPARATOR = ';'

// Mirror of snrc-resolve.py's split_links: trim each entry, drop empties so
// trailing/doubled separators and blank records all yield clean output.
const splitLinks = (value: string): string[] =>
  value
    .split(LINK_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)

async function fixture() {
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])

  // owner -> testing -> foobar.testing, with alice holding the 2LD. alice's
  // registry ownership of the 2LD node stands in for "alice holds the 2LD NFT"
  // (BaseRegistrar auto-reclaim keeps these equal on-chain).
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('testing'),
    ownerAccount.address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    namehash('testing'),
    labelhash('foobar'),
    aliceAccount.address,
  ])

  // Reverse namespace + registrar — the verbatim PublicResolver's ReverseClaimer
  // constructor looks up the reverse registrar via the registry, so this must
  // exist before the resolver is deployed.
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('reverse'),
    ownerAccount.address,
  ])
  const reverseRegistrar = await connection.viem.deployContract(
    'ReverseRegistrar',
    [ensRegistry.address],
  )
  await ensRegistry.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  // SubnameRegistrar(ens, baseRegistrar). ownerAccount stands in as the
  // BaseRegistrar so the test can drive subname creation directly.
  const subnames = await connection.viem.deployContract('SubnameRegistrar', [
    ensRegistry.address,
    ownerAccount.address,
  ])
  // SimplexResolver, wired with nameWrapper = subnames so it authorises
  // subname records against subnames.ownerOf.
  const resolver = await connection.viem.deployContract('SimplexResolver', [
    ensRegistry.address,
    subnames.address,
    zeroAddress,
    reverseRegistrar.address,
  ])
  await subnames.write.setResolver([resolver.address])
  await subnames.write.onExpiryChanged([NAME_NODE, 2n ** 64n], { account: ownerAccount })

  // UniversalResolver + its batch gateway. PublicResolver is a legacy resolver,
  // so the UR routes reads through the batch gateway; the `x-batch-gateway:true`
  // sentinel is handled in-process by viem's CCIP-read, no HTTP gateway needed.
  const batchGatewayProvider = await connection.viem.deployContract(
    'GatewayProvider',
    [ownerAccount.address, ['x-batch-gateway:true']],
  )
  const universalResolver = await connection.viem.deployContract(
    'UniversalResolver',
    [ownerAccount.address, ensRegistry.address, batchGatewayProvider.address],
  )

  // --- register the 2LD's records ---
  await ensRegistry.write.setResolver([NAME_NODE, resolver.address], {
    account: aliceAccount,
  })
  await resolver.write.setText([NAME_NODE, 'simplex.contact', 'smp://a;smp://b'], {
    account: aliceAccount,
  })
  await resolver.write.setText([NAME_NODE, 'simplex.channel', 'https://chan'], {
    account: aliceAccount,
  })

  // --- create the subname (soulbound to the 2LD) + its record ---
  await ensRegistry.write.setApprovalForAll([subnames.address, true], {
    account: aliceAccount,
  })
  await subnames.write.createSubname([NAME_NODE, 'bar'], { account: aliceAccount })
  await resolver.write.setText(
    [namehash(SUBNAME), 'simplex.contact', 'smp://phone'],
    { account: aliceAccount },
  )

  return { universalResolver }
}

const loadFixture = async () => connection.networkHelpers.loadFixture(fixture)

describe('SNRC resolution via UniversalResolver', () => {
  // Read one text record the way the resolver does, but through the
  // UniversalResolver (ENSIP-10): resolve(dnsEncode(name), text(node, key)).
  async function resolveText(
    universalResolver: any,
    name: string,
    key: string,
  ): Promise<string> {
    const call = encodeFunctionData({
      abi: PROFILE_ABI,
      functionName: 'text',
      args: [namehash(name), key],
    })
    const [result] = await universalResolver.read.resolve([
      dnsEncodeName(name),
      call,
    ])
    return decodeFunctionResult({
      abi: PROFILE_ABI,
      functionName: 'text',
      data: result,
    }) as string
  }

  // The snrc-resolve.py JSON shape for the SimpleX fields, rebuilt from
  // UniversalResolver reads.
  async function snrcResolve(universalResolver: any, name: string) {
    const [contact, channel] = await Promise.all([
      resolveText(universalResolver, name, 'simplex.contact'),
      resolveText(universalResolver, name, 'simplex.channel'),
    ])
    return {
      name,
      simplexContact: splitLinks(contact),
      simplexChannel: splitLinks(channel),
    }
  }

  it('resolves a 2LD name, splitting the multi-URL simplex records', async () => {
    const { universalResolver } = await loadFixture()
    expect(await snrcResolve(universalResolver, NAME)).toEqual({
      name: NAME,
      simplexContact: ['smp://a', 'smp://b'],
      simplexChannel: ['https://chan'],
    })
  })

  it('resolves a subname through the same UniversalResolver path', async () => {
    const { universalResolver } = await loadFixture()
    expect(await snrcResolve(universalResolver, SUBNAME)).toEqual({
      name: SUBNAME,
      simplexContact: ['smp://phone'],
      simplexChannel: [], // unset record resolves to an empty list
    })
  })
})
