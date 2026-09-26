// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ScalplessRWALedger} from "../src/ScalplessRWALedger.sol";

contract ScalplessRWALedgerTest is Test {
    ScalplessRWALedger ledger;
    address operator = address(0xA11CE);
    bytes32 drop = bytes32(uint256(0xD0));
    bytes32 claim = bytes32(uint256(0xC1));
    bytes32 holder = bytes32(uint256(0x85e3));
    bytes32 tx1 = bytes32(uint256(1));

    function setUp() public {
        ledger = new ScalplessRWALedger(operator);
        vm.prank(operator);
        ledger.listDrop(drop, "PS5 30th Anniversary", "gid://shopify/ProductVariant/1", 500_000_000, 1, tx1);
    }

    function test_fullLifecycle() public {
        vm.startPrank(operator);
        ledger.recordStage(claim, drop, ScalplessRWALedger.Stage.Won, holder, tx1);
        ledger.recordStage(claim, drop, ScalplessRWALedger.Stage.Financed, holder, tx1);
        ledger.recordRedeemed(claim, "gid://shopify/Order/42", tx1);
        ledger.recordShipped(claim, "1Z999");
        vm.stopPrank();
        (bytes32 d, bytes32 h, ScalplessRWALedger.Stage stage, string memory order, string memory tracking,) = ledger.claims(claim);
        assertEq(d, drop);
        assertEq(h, holder);
        assertEq(uint8(stage), uint8(ScalplessRWALedger.Stage.Shipped));
        assertEq(order, "gid://shopify/Order/42");
        assertEq(tracking, "1Z999");
        assertEq(ledger.claimCount(), 1);
    }

    function test_onlyOperatorWrites() public {
        vm.expectRevert(ScalplessRWALedger.NotOperator.selector);
        ledger.recordStage(claim, drop, ScalplessRWALedger.Stage.Won, holder, tx1);
    }

    function test_unknownDropRejected() public {
        vm.prank(operator);
        vm.expectRevert(ScalplessRWALedger.UnknownDrop.selector);
        ledger.recordStage(claim, bytes32(uint256(0xBAD)), ScalplessRWALedger.Stage.Won, holder, tx1);
    }

    function test_cannotShipBeforeRedeem() public {
        vm.startPrank(operator);
        ledger.recordStage(claim, drop, ScalplessRWALedger.Stage.Paid, holder, tx1);
        vm.expectRevert(ScalplessRWALedger.BadStage.selector);
        ledger.recordShipped(claim, "1Z999");
        vm.stopPrank();
    }

    function test_redeemOnlyThroughRecordRedeemed() public {
        vm.prank(operator);
        vm.expectRevert(ScalplessRWALedger.BadStage.selector);
        ledger.recordStage(claim, drop, ScalplessRWALedger.Stage.Redeemed, holder, tx1);
    }
}
