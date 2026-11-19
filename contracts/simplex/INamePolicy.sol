//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

interface ISettlement {
    function open(
        uint256 id,
        uint256 reversibleDays,
        uint256 duration,
        bool renewal
    ) external returns (uint256 extension);

    function reversiblePayment(
        uint256 id
    )
        external
        view
        returns (
            uint256 reversibleUntil,
            uint256 paidExpires,
            bool reversed,
            bool renewal
        );
}

interface INamePolicy {
    function settlement() external view returns (ISettlement);

    function consumeRegistration(
        string calldata label,
        bytes32 labelhash,
        bytes32 commitment,
        address owner
    ) external;

    function isReserved(bytes32 labelhash) external view returns (bool);

    function communityNames(bytes32 labelhash) external view returns (bool);

    function consumeTransfer(
        uint256 tokenId,
        address from,
        address to,
        uint256 offer,
        string calldata label
    ) external;

    function consumeRenewal(
        string calldata label,
        bytes32 labelhash,
        uint256 duration,
        address holder
    ) external;
}

interface INamePolicyBinding {
    function controller() external view returns (address);

    function registrar() external view returns (address);
}
