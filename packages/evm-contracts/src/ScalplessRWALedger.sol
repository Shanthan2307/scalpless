// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Scalpless RWA ledger
/// @notice Public, EVM-side record of every Scalpless claim — the tokenized right to one unit of a
///         merchant's Shopify inventory. The claim itself is a key-only object on Sui; this ledger
///         mirrors its lifecycle (won → paid / layaway / financed → resold → redeemed → shipped),
///         linked to the Shopify product variant and order it represents, plus the credit events
///         of the human-backed loans that paid for it.
/// @dev Written only by the Scalpless operator through Curvegrid MultiBaas, which indexes these
///      events for the merchant dashboard, the underwriting agent and the Shopify webhooks.
///      Sui identifiers (object ids, addresses, tx digests, human keys) are 32 bytes → bytes32.
contract ScalplessRWALedger {
    enum Stage {
        None,
        Won,
        LivenessVerified,
        Paid,
        Layaway,
        Financed,
        Listed,
        Resold,
        Redeemed,
        Shipped,
        LayawayDefaulted
    }

    enum Credit {
        None,
        LoanOpened,
        Repayment,
        LoanClosed,
        MarkedLate,
        Defaulted
    }

    struct DropRecord {
        string title;
        string shopifyVariant; // e.g. gid://shopify/ProductVariant/123 ("" if not a Shopify drop)
        uint64 facePriceMist;
        uint64 units;
        bool exists;
    }

    struct ClaimRecord {
        bytes32 dropId;
        bytes32 holder; // Sui address of the current holder
        Stage stage;
        string shopifyOrder; // set on redemption
        string tracking; // set on shipment
        uint64 updatedAt;
    }

    address public operator;
    uint256 public claimCount;
    mapping(bytes32 => DropRecord) public drops;
    mapping(bytes32 => ClaimRecord) public claims;

    event OperatorChanged(address indexed operator);
    event DropListed(bytes32 indexed dropId, string title, string shopifyVariant, uint64 facePriceMist, uint64 units, bytes32 suiTx);
    event ClaimStageChanged(bytes32 indexed claimId, bytes32 indexed dropId, Stage stage, bytes32 holder, bytes32 suiTx);
    event ClaimRedeemed(bytes32 indexed claimId, bytes32 indexed dropId, string shopifyOrder, bytes32 suiTx);
    event ClaimShipped(bytes32 indexed claimId, string tracking);
    event CreditEvent(bytes32 indexed humanKey, Credit kind, uint64 amountMist, bytes32 suiTx);

    error NotOperator();
    error UnknownDrop();
    error UnknownClaim();
    error BadStage();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address operator_) {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function listDrop(
        bytes32 dropId,
        string calldata title,
        string calldata shopifyVariant,
        uint64 facePriceMist,
        uint64 units,
        bytes32 suiTx
    ) external onlyOperator {
        drops[dropId] = DropRecord(title, shopifyVariant, facePriceMist, units, true);
        emit DropListed(dropId, title, shopifyVariant, facePriceMist, units, suiTx);
    }

    /// @notice Record a lifecycle step of a claim (first call registers the claim).
    function recordStage(bytes32 claimId, bytes32 dropId, Stage stage, bytes32 holder, bytes32 suiTx) external onlyOperator {
        if (!drops[dropId].exists) revert UnknownDrop();
        if (stage == Stage.None || stage == Stage.Redeemed || stage == Stage.Shipped) revert BadStage();
        ClaimRecord storage c = claims[claimId];
        if (c.stage == Stage.None) claimCount++;
        c.dropId = dropId;
        c.holder = holder;
        c.stage = stage;
        c.updatedAt = uint64(block.timestamp);
        emit ClaimStageChanged(claimId, dropId, stage, holder, suiTx);
    }

    /// @notice The holder redeemed the claim on Sui (burning it) and a Shopify order was created.
    function recordRedeemed(bytes32 claimId, string calldata shopifyOrder, bytes32 suiTx) external onlyOperator {
        ClaimRecord storage c = claims[claimId];
        if (c.stage == Stage.None) revert UnknownClaim();
        c.stage = Stage.Redeemed;
        c.shopifyOrder = shopifyOrder;
        c.updatedAt = uint64(block.timestamp);
        emit ClaimRedeemed(claimId, c.dropId, shopifyOrder, suiTx);
    }

    /// @notice The merchant fulfilled the Shopify order.
    function recordShipped(bytes32 claimId, string calldata tracking) external onlyOperator {
        ClaimRecord storage c = claims[claimId];
        if (c.stage != Stage.Redeemed) revert BadStage();
        c.stage = Stage.Shipped;
        c.tracking = tracking;
        c.updatedAt = uint64(block.timestamp);
        emit ClaimShipped(claimId, tracking);
    }

    function recordCredit(bytes32 humanKey, Credit kind, uint64 amountMist, bytes32 suiTx) external onlyOperator {
        if (kind == Credit.None) revert BadStage();
        emit CreditEvent(humanKey, kind, amountMist, suiTx);
    }
}
