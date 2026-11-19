import { readFileSync, writeFileSync } from 'node:fs'

const R = 'contracts/ethregistrar/BaseRegistrarImplementation.sol'
const P = 'contracts/simplex/SimplexNamePolicy.sol'
const C = 'contracts/simplex/SimplexController.sol'
const N = 'contracts/simplex/SimplexSponsor.sol'

export const mutants = [
  [R, 'disputeUntil[id] = disputePeriod == 0 ? 0 : block.timestamp + disputePeriod;', ''],
  [R, 'disputeUntil[id] = disputePeriod == 0 ? 0 : block.timestamp + disputePeriod;', 'disputeUntil[id] = block.timestamp + disputePeriod;'],
  [R, 'disputeUntil[id] = disputePeriod == 0 ? 0 : block.timestamp + disputePeriod;', 'disputeUntil[id] = disputePeriod == 0 ? 0 : block.timestamp;'],
  [R, 'if (block.timestamp >= disputeUntil[id]) revert DisputePeriodOver(id);', ''],
  [R, 'if (block.timestamp >= disputeUntil[id])', 'if (block.timestamp > disputeUntil[id])'],
  [R, 'delete disputeUntil[id];', ''],
  [R, 'expiries[id] = 0;', ''],
  [R, 'ens.setSubnodeRecord(baseNode, bytes32(id), address(0), address(0), 0);', ''],
  [R, 'ens.setSubnodeRecord(baseNode, bytes32(id), address(0), address(0), 0);', 'ens.setSubnodeOwner(baseNode, bytes32(id), address(0));'],
  [R, 'ISubnameHook(subnameHook).onExpiryChanged(\n                keccak256(abi.encodePacked(baseNode, bytes32(id))),\n                0\n            );', ''],
  [R, 'function unregister(uint256 id) external live onlyController {', 'function unregister(uint256 id) external live {'],
  [C, 'if (disputeDays < MIN_DISPUTE_DAYS || disputeDays > MAX_DISPUTE_DAYS)\n            revert DisputeDaysOutOfRange(disputeDays);', ''],
  [C, 'disputeDays < MIN_DISPUTE_DAYS ||', 'disputeDays <= MIN_DISPUTE_DAYS ||'],
  [C, '|| disputeDays > MAX_DISPUTE_DAYS', '|| disputeDays >= MAX_DISPUTE_DAYS'],
  [C, '_registerCore(registration, labelhash, price, 0);', '_registerCore(registration, labelhash, price, MIN_DISPUTE_DAYS * 1 days);'],
  [C, 'disputeDays * 1 days);', 'disputeDays);'],
  [C, 'function unregister(string calldata label) external onlyOwnerOrBeneficiary {', 'function unregister(string calldata label) external {'],
  [C, '_retireStaleRecords(node);\n        address resolver = defaultResolver;', 'address resolver = defaultResolver;'],
  [C, 'if (resolver != address(0)) IClearableResolver(resolver).clearRecords(node);', ''],
  [C, 'if (resolver != address(0)) IClearableResolver(resolver).clearRecords(node);', 'IClearableResolver(resolver).clearRecords(node);'],
  [C, 'function unregister(string calldata label) external onlyOwnerOrBeneficiary {', 'function unregister(string calldata label) external onlyOwnerOrBeneficiary {\n        if (frozen) revert Frozen();'],
  [R, 'if (block.timestamp < disputeUntil[id]) revert DisputePeriodNotOver(id);', ''],
  [R, 'if (block.timestamp < disputeUntil[id])', 'if (block.timestamp <= disputeUntil[id])'],
  [P, 'registrar.registerWithLabel(label, address(this), duration, 0);', 'registrar.registerWithLabel(label, address(this), duration, 1 days);'],
  [N, 'keccak256(abi.encodePacked(dataHashes)),\n                        disputeDays,', 'keccak256(abi.encodePacked(dataHashes)),\n                        uint256(0),'],
]

const index = Number(process.argv[2])
const [file, from, to] = mutants[index]
const source = readFileSync(file, 'utf8')
if (source.split(from).length !== 2) throw new Error(`mutant ${index}: expected one match in ${file}`)
writeFileSync(file, source.replace(from, to))
console.log(`mutant ${index} in ${file}:\n- ${from}\n+ ${to}`)
