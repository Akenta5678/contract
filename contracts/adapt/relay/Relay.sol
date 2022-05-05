// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;
pragma abicoder v2;

// OpenZeppelin v4
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IWBase } from "./IWBase.sol";
import { RailgunLogic, Transaction, CommitmentPreimage, TokenData, TokenType } from "../../logic/RailgunLogic.sol";

/**
 * @title Relay Adapt
 * @author Railgun Contributors
 * @notice Multicall adapt contract for Railgun with relayer support
 */

contract RelayAdapt is ReentrancyGuard {
  using SafeERC20 for IERC20;

  struct Call {
    address to;
    bytes data;
    uint256 value;
  }

  struct Result {
    bool success;
    bytes returnData;
  }

  RailgunLogic public railgun;
  IWBase public wbase;


  /**
   * @notice Only allows reentrancy from self
   */
  modifier onlySelfReenter () {
    // @todo Modify https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/security/ReentrancyGuard.sol
    // This prevents malicious contracts that are being interacted with as part of a multicall
    // from being able to steal funds through reentry or callbacks
    require(
      msg.sender == tx.origin
      || msg.sender == address(this)
      , "GeneralAdapt: Caller is external contract"
    );

    _;
  }

  /**
   * @notice Sets Railgun contract and weth address
   */
  constructor(RailgunLogic _railgun, IWBase _wbase) {
    railgun = _railgun;
    wbase = _wbase;
  }

  /**
   * @notice Executes multicall batch
   * @param _requireSuccess - Whether transaction should throw on multicall failure
   * @param _calls - multicall
   */
  function multicall(
    bool _requireSuccess,
    Call[] calldata _calls
  ) public onlySelfReenter returns (Result[] memory) {
    // Initialize returnData array
    Result[] memory returnData = new Result[](_calls.length);

    // Loop through each call
    for(uint256 i = 0; i < _calls.length; i++) {
      // Retrieve call
      Call calldata call = _calls[i];

      // NOTE:
      // If any of these calls are a direct railgun transaction or railgunBatch, adapt contract should be set to this contracts address
      // and adapt paramemters set to 0. This will ensure that the transaction can't be extracted and submitted
      // standalone

      // Execute call
      (bool success, bytes memory ret) = call.to.call{value: call.value}(call.data);

      // If requireSuccess is true, throw on failure
      if (_requireSuccess) {
        require(success, "GeneralAdapt: Call Failed");
      }

      // Add call result to returnData
      returnData[i] = Result(success, ret);
    }

    return returnData;
  }

  /**
   * @notice Executes a batch of Railgun transactions
   * @param _transactions - Batch of Railgun transactions to execute
   * @param _additionalData - Additional data
   * Should be 0 if being executed as part of a multicall step
   */
  function getAdaptParamsValue(
    Transaction[] calldata _transactions,
    bytes memory _additionalData
  ) public returns (bytes32) {
    // Calculate the expected adaptID parameters value

    // The first nullifier is used here to ensure that transactions can't be switched out in the mempool
    uint256[] memory firstNullifiers = new uint256[](_transactions.length);
    for (uint256 i = 0; i < _transactions.length; i++) {
      // Only need first nullifier
      firstNullifiers[i] = _transactions[i].nullifiers[0];
    }

    // Return adapt params value
    return keccak256(
      abi.encode(
        firstNullifiers,
        _transactions.length,
        _additionalData
      )
    );
  }

  /**
   * @notice Executes a batch of Railgun transactions
   * @param _transactions - Batch of Railgun transactions to execute
   * @param _additionalData - Additional data
   * Should be 0 if being executed as part of a multicall step
   */
  function railgunBatch(
    Transaction[] calldata _transactions,
    bytes memory _additionalData
  ) public onlySelfReenter {
    bytes32 expectedAdaptParameters = getAdaptParamsValue(_transactions, _additionalData);

    // Loop through each transaction and ensure adaptID parameters match
    for(uint256 i = 0; i < _transactions.length; i++) {
      require(_transactions[i].boundParams.adaptParams == expectedAdaptParameters, "GeneralAdapt: AdaptID Parameters Mismatch");
    }

    // Execute railgun transactions
    railgun.transact(_transactions);
  }

  /**
   * @notice Executes a batch of Railgun deposits
   * @param _deposits - Tokens to deposit
   * @param _encryptedRandom - Encrypted random value for deposits
   * @param _npk - note public key to deposit to
   */
  function deposit(
    TokenData[] calldata _deposits,
    uint256[2] calldata _encryptedRandom,
    uint256 _npk
  ) public onlySelfReenter {
    // Loop through each token specified for deposit and deposit our total balance
    // Due to a quirk with the USDT token contract this will fail if it's approval is
    // non-0 (https://github.com/Uniswap/interface/issues/1034), to ensure that your
    // transaction always succeeds when dealing with USDT/similar tokens make sure the last
    // call in your calls is a call to the token contract with an approval of 0
    CommitmentPreimage[] memory commitmentPreimages = new CommitmentPreimage[](_deposits.length);
    uint256[2][] memory encryptedRandom = new uint256[2][](_deposits.length);

    for (uint256 i = 0; i < _deposits.length; i++) {
      if (_deposits[i].tokenType == TokenType.ERC20) {
        IERC20 token = IERC20(_deposits[i].tokenAddress);

        // Fetch balance
        uint256 balance = token.balanceOf(address(this));

        // Approve the balance for deposit
        token.safeApprove(
          address(railgun),
          balance
        );

        // Push to deposits arrays
        commitmentPreimages[i] = CommitmentPreimage({
          npk: _npk,
          value: uint120(balance),
          token: _deposits[i]
        });
        encryptedRandom[i] = _encryptedRandom;
      } else if (_deposits[i].tokenType == TokenType.ERC721) {
        // ERC721 token
        revert("GeneralAdapt: ERC721 not yet supported");
      } else if (_deposits[i].tokenType == TokenType.ERC1155) {
        // ERC1155 token
        revert("GeneralAdapt: ERC1155 not yet supported");
      } else {
        // Invalid token type, revert
        revert("GeneralAdapt: Unknown token type");
      }
    }

    // Deposit back to Railgun
    railgun.generateDeposit(commitmentPreimages, encryptedRandom);
  }

  /**
   * @notice Sends tokens to particular address
   * @param _tokens - ERC20 tokens to send (0x0 is eth)
   * @param _to - ETH address to send to
   */
   function send(
    IERC20[] calldata _tokens,
    address _to
  ) public onlySelfReenter {
    // Loop through each token specified for deposit and deposit our total balance
    // Due to a quirk with the USDT token contract this will fail if it's approval is
    // non-0 (https://github.com/Uniswap/interface/issues/1034), to ensure that your
    // transaction always succeeds when dealing with USDT/similar tokens make sure the last
    // call in your calls is a call to the token contract with an approval of 0
    for (uint256 i = 0; i < _tokens.length; i++) {
      IERC20 token = _tokens[i];

      if (address(token) == address(0x0)) {
        // Fetch ETH balance
        uint256 balance = address(this).balance;

        // Send ETH
        (bool sent,) = _to.call{value: balance}("");
        require(sent, "Failed to send Ether");
      } else {
        // Fetch balance
        uint256 balance = token.balanceOf(address(this));

        // Send all to address
        token.safeTransfer(_to, balance);
      }
    }
  }

  /**
   * @notice Wraps all base tokens in contract
   */
  function wrapAllBase() public onlySelfReenter {
    // Fetch ETH balance
    uint256 balance = address(this).balance;

    // Wrap
    wbase.deposit{value: balance}();
  }

  /**
   * @notice Unwraps all wrapped base tokens in contract
   */
  function unwrapAllBase() public onlySelfReenter {
    // Fetch ETH balance
    uint256 balance = wbase.balanceOf(address(this));

    // Unwrap
    wbase.withdraw(balance);
  }

  /**
   * @notice Convenience function to get the adapt params value for a given set of transactions
   * and calls
   * @param _transactions - Batch of Railgun transactions to execute
   * @param _random - Random value (shouldn't be reused if resubmitting the same transaction
   * through another relayer or resubmitting on failed transaction - the same nullifier:random
   * should never be reused)
   * @param _requireSuccess - Whether transaction should throw on multicall failure
   * @param _calls - multicall
   */
  function getAdaptParamsValue(
    Transaction[] calldata _transactions,
    uint256 _random,
    bool _requireSuccess,
    Call[] calldata _calls
  ) external returns (bytes32) {
    // Convenience function to get the expected adaptID parameters value for global
    bytes memory additionalData = abi.encode(
      _random,
      _requireSuccess,
      _calls
    );

    // Return adapt params value
    return getAdaptParamsValue(_transactions, additionalData);
  }

  /**
   * @notice Executes a batch of Railgun transactions followed by a multicall
   * @param _transactions - Batch of Railgun transactions to execute
   * @param _random - Random value (shouldn't be reused if resubmitting the same transaction
   * through another relayer or resubmitting on failed transaction - the same nullifier:random
   * should never be reused)
   * @param _requireSuccess - Whether transaction should throw on multicall failure
   * @param _calls - multicall
   */
  function relay(
    Transaction[] calldata _transactions,
    uint256 _random,
    bool _requireSuccess,
    Call[] calldata _calls
  ) public payable returns (Result[] memory) {
    // Calculate additionalData parameter for adaptID parameters
    bytes memory additionalData = abi.encode(
      _random,
      _requireSuccess,
      _calls
    );

    // Executes railgun batch
    railgunBatch(_transactions, additionalData);

    // Execute multicalls
    Result[] memory returnData = multicall(_requireSuccess, _calls);

    // To execute a multicall and deposit or send the resulting tokens, encode a call to the relevant function on this
    // contract at the end of your calls array.

    // Return returnData
    return returnData;
  }
}