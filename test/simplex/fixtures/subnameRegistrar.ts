import type { NetworkConnection } from 'hardhat/types/network'
import { encodeFunctionData, type Address } from 'viem'

/** Deploys SubnameRegistrar behind its UUPS proxy, owned by the deployer. */
export async function deploySubnameRegistrar(
  viem: NetworkConnection['viem'],
  ens: Address,
  baseRegistrar: Address,
) {
  const [deployer] = await viem.getWalletClients()
  const implementation = await viem.deployContract('SubnameRegistrar', [])
  const proxy = await viem.deployContract('SubnameRegistrarProxy', [
    implementation.address,
    encodeFunctionData({
      abi: implementation.abi,
      functionName: 'initialize',
      args: [ens, baseRegistrar, deployer.account.address],
    }),
  ])
  return viem.getContractAt('SubnameRegistrar', proxy.address)
}
