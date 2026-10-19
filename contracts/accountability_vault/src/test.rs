#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, BytesN, Env, String,
};

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    token: Address,
    creator: Address,
    verifier: Address,
    success: Address,
    failure: Address,
    vault_id: String,
}

fn evidence_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

fn setup(milestone_due_offsets: &[u64], amounts: &[i128]) -> Setup {
    setup_with_oracle(milestone_due_offsets, amounts, false)
}

/// `with_oracle` must be a flag rather than a caller-supplied address: the test
/// environment derives addresses deterministically, so an address generated in
/// a different `Env` collides with the creator and would (correctly) be
/// rejected by `CreatorIsVerifier`.
fn setup_with_oracle(milestone_due_offsets: &[u64], amounts: &[i128], with_oracle: bool) -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let oracle = if with_oracle {
        Some(Address::generate(&env))
    } else {
        None
    };

    let (token, token_admin_client) = create_token(&env, &token_admin);
    let total: i128 = amounts.iter().sum();
    token_admin_client.mint(&creator, &total);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-627");

    let mut milestones = vec![&env];
    for (i, due) in milestone_due_offsets.iter().enumerate() {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "m"),
            amount: amounts[i],
            due_date: 1_000 + due,
            verified: false,
            released: false,
        });
    }

    let end = 1_000 + milestone_due_offsets.iter().max().copied().unwrap_or(0);
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1,
    };

    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &oracle,
        &token,
        &total,
        &success,
        &failure,
        &end,
        &milestones,
    );

    Setup {
        env,
        contract,
        token,
        creator,
        verifier,
        success,
        failure,
        vault_id,
    }
}

#[test]
fn test_slash_before_deadline_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_099);
    let before = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(matches!(before, Err(Ok(Error::DeadlineNotReached))));

    s.env.ledger().set_timestamp(1_100);
    let exactly_at_deadline = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(matches!(
        exactly_at_deadline,
        Err(Ok(Error::DeadlineNotReached))
    ));

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);
}

#[test]
fn test_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_101);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_double_slash_after_miss_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);
    let second = s.contract.try_slash_on_miss(&s.vault_id);

    assert!(matches!(second, Err(Ok(Error::NotActive))));
    assert_eq!(
        s.contract.get_vault(&s.vault_id).status,
        VaultStatus::Failed
    );
}

#[test]
fn test_check_in_after_slash_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);
    s.contract.slash_on_miss(&s.vault_id);

    let result = s
        .contract
        .try_check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::NotActive))));
}

#[test]
fn test_unauthorized_caller_check_in_fails() {
    let s = setup_with_oracle(&[100], &[500], true);
    s.contract.stake(&s.vault_id, &s.creator);

    let random = Address::generate(&s.env);
    let result = s
        .contract
        .try_check_in(&s.vault_id, &random, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::Unauthorized))));
}

#[test]
fn test_oracle_not_set_random_caller_check_in_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let random = Address::generate(&s.env);
    let result = s
        .contract
        .try_check_in(&s.vault_id, &random, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::Unauthorized))));
}

#[test]
fn test_verifier_check_in_still_works_with_oracle_configured() {
    let s = setup_with_oracle(&[100], &[500], true);
    s.contract.stake(&s.vault_id, &s.creator);

    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));

    let vault = s.contract.get_vault(&s.vault_id);
    assert!(vault.milestones.get(0).unwrap().verified);
    assert_eq!(vault.status, VaultStatus::Active);
}

#[test]
fn test_gas_benchmarks_slash_on_miss_10_milestones() {
    let offsets: [u64; 10] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    let amounts: [i128; 10] = [100; 10];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_101);
    s.env.budget().reset_default();
    s.contract.slash_on_miss(&s.vault_id);

    let slash_cpu = s.env.budget().cpu_instruction_cost();
    let slash_mem = s.env.budget().memory_bytes_cost();

    std::println!(
        "slash_on_miss_10_milestones: CPU = {}, Memory = {}",
        slash_cpu,
        slash_mem
    );
    assert!(slash_cpu < 900_000);
    assert!(slash_mem < 250_000);
}

// ═══════════════════════════════════════════════════════════════════════
// i128 milestone-amount partial-payout boundary test matrix
//
// Invariants under test:
//   1. sum(milestone.amount) == vault.amount  (enforced at creation)
//   2. After sequentially claiming all milestones, vault.staked == 0
//   3. No panic / overflow on extreme i128 values
//   4. Rounding never drains escrow below solvency (staked >= 0 after
//      every intermediate claim_milestone)
//   5. Zero-amount milestones are rejected at creation
//   6. Slash transfers the full staked balance regardless of amount size
// ═══════════════════════════════════════════════════════════════════════

/// Helper: create vault, stake, verify all milestones, then claim them
/// one-by-one. Returns the final vault state.
fn claim_all_milestones_sequentially(offsets: &[u64], amounts: &[i128]) -> Vault {
    let s = setup(offsets, amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify every milestone.
    for i in 0..amounts.len() {
        s.contract.check_in(
            &s.vault_id,
            &s.verifier,
            &(i as u32),
            &evidence_hash(&s.env, i as u8),
        );
    }

    // Claim milestones one at a time and assert intermediate solvency.
    let token_client = token::Client::new(&s.env, &s.token);
    let contract_addr = s.contract.address.clone();
    let total: i128 = amounts.iter().sum();

    let mut released_so_far: i128 = 0;
    for i in 0..amounts.len() {
        s.contract
            .claim_milestone(&s.vault_id, &s.creator, &(i as u32));
        released_so_far += amounts[i];

        let vault = s.contract.get_vault(&s.vault_id);
        // Solvency: staked must equal what remains.
        assert_eq!(
            vault.staked,
            total - released_so_far,
            "solvency violation after claiming milestone {}",
            i
        );
        // Contract balance must cover the remaining staked amount.
        assert!(
            token_client.balance(&contract_addr) >= vault.staked,
            "contract balance underflow after milestone {}",
            i
        );
    }

    s.contract.get_vault(&s.vault_id)
}

// ─── 1. Minimum valid amount (1 unit per milestone) ─────────────────

#[test]
fn test_boundary_single_milestone_amount_one() {
    let vault = claim_all_milestones_sequentially(&[100], &[1]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_three_milestones_amount_one_each() {
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[1, 1, 1]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 2. Large near-max i128 amounts ─────────────────────────────────

#[test]
fn test_boundary_single_milestone_large_amount() {
    // Use a large value that stays well within i128::MAX but exercises
    // high-magnitude arithmetic (10^36).
    let large: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000; // 10^36
    let vault = claim_all_milestones_sequentially(&[100], &[large]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_two_milestones_sum_near_max() {
    // Two milestones whose sum is close to i128::MAX.
    // i128::MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727
    let half = i128::MAX / 2; // 85_070_591_730_234_615_865_843_651_857_942_052_863
    let other_half = i128::MAX - half; // 85_070_591_730_234_615_865_843_651_857_942_052_864
    assert_eq!(half + other_half, i128::MAX);

    let s = setup(&[100, 200], &[half, other_half]);

    // Vault creation succeeds, proving the sum check handles i128::MAX.
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.amount, i128::MAX);
    assert_eq!(vault.milestones.len(), 2);
    assert_eq!(vault.milestones.get(0).unwrap().amount, half);
    assert_eq!(vault.milestones.get(1).unwrap().amount, other_half);
}

// ─── 3. Uneven 3-way split with remainder ───────────────────────────

#[test]
fn test_boundary_uneven_three_way_split() {
    // 100 / 3 = 33 remainder 1. We split as 34 + 33 + 33 so the sum is exact.
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[34, 33, 33]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_uneven_seven_way_split() {
    // 1_000_000 across 7 milestones. 1_000_000 / 7 = 142_857 rem 1.
    // Distribute as: 6 × 142_857 + 1 × 142_858 = 1_000_000.
    let amounts: [i128; 7] = [
        142_857, 142_857, 142_857, 142_857, 142_857, 142_857, 142_858,
    ];
    let offsets: [u64; 7] = [10, 20, 30, 40, 50, 60, 70];
    assert_eq!(amounts.iter().sum::<i128>(), 1_000_000);

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_prime_split() {
    // A prime total (997) split across 3 milestones.
    // 997 / 3 = 332 rem 1 → 333 + 332 + 332.
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[333, 332, 332]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 4. Bulk claim path with boundary amounts ───────────────────────

#[test]
fn test_boundary_bulk_claim_amount_one() {
    let s = setup(&[100], &[1]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_bulk_claim_large_amount() {
    let large: i128 = 999_999_999_999_999_999_999_999_999; // ~10^27
    let s = setup(&[100], &[large]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    let success_dest = vault.success_destination;
    assert_eq!(token_client.balance(&success_dest), large);
}

// ─── 5. Slash path with boundary amounts ────────────────────────────

#[test]
fn test_boundary_slash_amount_one() {
    let s = setup(&[100], &[1]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 1);
}

#[test]
fn test_boundary_slash_large_amount() {
    let large: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000; // 10^36
    let s = setup(&[100], &[large]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), large);
}

#[test]
fn test_boundary_slash_uneven_multi_milestone() {
    // 5 milestones with uneven amounts; slash must transfer entire staked
    // balance regardless of per-milestone distribution.
    let amounts: [i128; 5] = [17, 31, 29, 11, 12];
    let offsets: [u64; 5] = [10, 20, 30, 40, 50];
    let total: i128 = amounts.iter().sum();

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_051);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), total);
}

// ─── 6. Mixed large + small milestones ──────────────────────────────

#[test]
fn test_boundary_mixed_large_and_tiny_milestones() {
    // One very large milestone alongside a single-unit milestone.
    // Tests that subtracting 1 from a huge staked value doesn't break.
    let large: i128 = 999_999_999_999_999_999;
    let amounts = [large, 1];
    let offsets = [100, 200];

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_descending_powers_of_ten() {
    // Milestones: 10^12, 10^6, 10^3, 10^0 = [1_000_000_000_000, 1_000_000, 1_000, 1]
    let amounts: [i128; 4] = [1_000_000_000_000, 1_000_000, 1_000, 1];
    let offsets: [u64; 4] = [100, 200, 300, 400];

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 7. Rejection of invalid amounts at vault creation ──────────────

#[test]
fn test_boundary_zero_amount_milestone_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-zero");

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 0,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 100,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
    );
    assert!(matches!(result, Err(Ok(Error::InvalidAmount))));
}

#[test]
fn test_boundary_negative_amount_milestone_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-neg");

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: -1,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 101,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
    );
    assert!(matches!(result, Err(Ok(Error::InvalidAmount))));
}

#[test]
fn test_boundary_milestone_sum_mismatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-mis");

    // Milestones sum to 99 but declared amount is 100.
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 50,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 49,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
    );
    assert!(matches!(result, Err(Ok(Error::AmountMismatch))));
}

// ─── 8. Partial claim then slash (mixed path) ───────────────────────

#[test]
fn test_boundary_partial_claim_then_bulk_claim_rejected() {
    // After claiming one milestone via claim_milestone, bulk claim must be
    // rejected to prevent double-release.
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify all milestones.
    for i in 0..3u32 {
        s.contract.check_in(
            &s.vault_id,
            &s.verifier,
            &i,
            &evidence_hash(&s.env, i as u8),
        );
    }

    // Claim only the first milestone.
    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 500); // 600 - 100

    // Bulk claim must be rejected.
    let result = s.contract.try_claim(&s.vault_id, &s.creator);
    assert!(matches!(result, Err(Ok(Error::PartiallyReleased))));
}

// ─── 9. Double claim_milestone rejected ─────────────────────────────

#[test]
fn test_boundary_double_claim_milestone_rejected() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    let result = s.contract.try_claim_milestone(&s.vault_id, &s.creator, &0);
    // Second claim should fail because vault is now Completed (single milestone).
    assert!(result.is_err());
}

// ─── 10. Solvency matrix: N milestones claimed in various orders ────

#[test]
fn test_boundary_reverse_order_claim() {
    // Claim milestones in reverse order to verify staked balance
    // is exact regardless of claim sequence.
    let amounts: [i128; 4] = [1, 2, 3, 4];
    let offsets: [u64; 4] = [100, 200, 300, 400];
    let total: i128 = amounts.iter().sum(); // 10

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    for i in 0..4u32 {
        s.contract.check_in(
            &s.vault_id,
            &s.verifier,
            &i,
            &evidence_hash(&s.env, i as u8),
        );
    }

    let mut released: i128 = 0;
    for i in (0..4u32).rev() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &i);
        released += amounts[i as usize];

        let vault = s.contract.get_vault(&s.vault_id);
        assert_eq!(
            vault.staked,
            total - released,
            "solvency violation after reverse-claiming milestone {}",
            i
        );
    }

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_interleaved_claim_order() {
    // Claim in order: 2, 0, 4, 1, 3 (non-sequential).
    let amounts: [i128; 5] = [10, 20, 30, 40, 50];
    let offsets: [u64; 5] = [100, 200, 300, 400, 500];
    let total: i128 = amounts.iter().sum(); // 150

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    for i in 0..5u32 {
        s.contract.check_in(
            &s.vault_id,
            &s.verifier,
            &i,
            &evidence_hash(&s.env, i as u8),
        );
    }

    let claim_order: [u32; 5] = [2, 0, 4, 1, 3];
    let mut released: i128 = 0;
    for &idx in claim_order.iter() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &idx);
        released += amounts[idx as usize];

        let vault = s.contract.get_vault(&s.vault_id);
        assert_eq!(
            vault.staked,
            total - released,
            "solvency violation after claiming milestone {} (interleaved)",
            idx
        );
        // Invariant: staked must never go negative.
        assert!(vault.staked >= 0, "negative staked after milestone {}", idx);
    }

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 11. Boundary: many milestones with amount=1 ────────────────────

#[test]
fn test_boundary_twenty_milestones_amount_one() {
    let n = 20;
    let amounts = [1i128; 20];
    // `Vec` is `soroban_sdk::Vec` in this module; these helpers take std slices.
    let offsets: std::vec::Vec<u64> = (1..=n).map(|i| i as u64 * 10).collect();

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 12. Boundary: large remainder routing across many milestones ───

#[test]
fn test_boundary_large_total_uneven_13_way_split() {
    // Total: 10^18, 13 milestones.
    // 10^18 / 13 = 76_923_076_923_076_923 rem 1.
    let base: i128 = 76_923_076_923_076_923;
    let mut amounts = [base; 13];
    amounts[12] = base + 1; // absorb the remainder
    let total: i128 = amounts.iter().sum();
    assert_eq!(total, 1_000_000_000_000_000_000i128);

    let offsets: std::vec::Vec<u64> = (1..=13).map(|i| i as u64 * 10).collect();
    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 13. Boundary: title length bound ────────────────────────────────

#[test]
fn test_create_vault_title_length_bound() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _token_admin_client) = create_token(&env, &token_admin);
    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-title-test");

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    // Exactly 128 chars -> OK
    let title_128 = String::from_str(
        &env,
        "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    );
    let milestones_ok = vec![
        &env,
        Milestone {
            title: title_128,
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];

    let res = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones_ok,
    );
    assert!(res.is_ok());

    // 129 chars -> TitleTooLong
    let title_129 = String::from_str(
        &env,
        "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    );
    let milestones_err = vec![
        &env,
        Milestone {
            title: title_129,
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];
    let vault_id_2 = String::from_str(&env, "vault-title-test-2");
    let res_err = contract.try_create_vault(
        &vault_id_2,
        &creator,
        &verifier_set,
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones_err,
    );
    assert_eq!(res_err, Err(Ok(Error::TitleTooLong)));
}

// ─── 14. create_vault verifier-set hardening (#1713) ─────────────────

struct CreateFixture {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    token: Address,
    creator: Address,
    success: Address,
    failure: Address,
}

fn create_fixture() -> CreateFixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    CreateFixture {
        env,
        contract,
        token,
        creator,
        success,
        failure,
    }
}

fn verifier_set_of(env: &Env, verifiers: &[Address], threshold: u32) -> VerifierSet {
    let mut list = vec![env];
    for verifier in verifiers {
        list.push_back(verifier.clone());
    }
    VerifierSet {
        verifiers: list,
        threshold,
    }
}

fn one_milestone(env: &Env, amount: i128, due_date: u64) -> Vec<Milestone> {
    vec![
        env,
        Milestone {
            title: String::from_str(env, "m1"),
            amount,
            due_date,
            verified: false,
            released: false,
        },
    ]
}

#[test]
fn test_create_vault_rejects_creator_as_verifier() {
    let f = create_fixture();
    let verifier_set = verifier_set_of(&f.env, &[f.creator.clone()], 1);

    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-creator-verifier"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );

    assert_eq!(result, Err(Ok(Error::CreatorIsVerifier)));
}

#[test]
fn test_create_vault_rejects_creator_as_oracle() {
    let f = create_fixture();
    let verifier = Address::generate(&f.env);
    let verifier_set = verifier_set_of(&f.env, &[verifier], 1);

    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-creator-oracle"),
        &f.creator,
        &verifier_set,
        &Some(f.creator.clone()),
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );

    assert_eq!(result, Err(Ok(Error::CreatorIsVerifier)));
}

#[test]
fn test_create_vault_rejects_duplicate_verifiers() {
    let f = create_fixture();
    let verifier = Address::generate(&f.env);
    let verifier_set = verifier_set_of(&f.env, &[verifier.clone(), verifier], 2);

    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-duplicate-verifier"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );

    assert_eq!(result, Err(Ok(Error::DuplicateVerifier)));
}

#[test]
fn test_create_vault_rejects_too_many_verifiers() {
    let f = create_fixture();
    let mut verifiers = vec![&f.env];
    for _ in 0..=MAX_VERIFIERS {
        verifiers.push_back(Address::generate(&f.env));
    }
    let verifier_set = VerifierSet {
        verifiers,
        threshold: 1,
    };

    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-too-many-verifiers"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );

    assert_eq!(result, Err(Ok(Error::TooManyVerifiers)));
}

#[test]
fn test_create_vault_rejects_already_expired_milestone() {
    let f = create_fixture();
    let verifier = Address::generate(&f.env);
    let verifier_set = verifier_set_of(&f.env, &[verifier], 1);

    // The ledger is at 1_000, so a due date of exactly 1_000 can never be
    // checked in (`check_in` rejects `timestamp > due_date` only, but the
    // milestone must still have a future due date at creation time).
    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-expired-milestone"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_000),
    );

    assert_eq!(result, Err(Ok(Error::InvalidDeadline)));
}

#[test]
fn test_create_vault_rejects_equal_destinations() {
    let f = create_fixture();
    let verifier = Address::generate(&f.env);
    let verifier_set = verifier_set_of(&f.env, &[verifier], 1);

    let result = f.contract.try_create_vault(
        &String::from_str(&f.env, "v-equal-destinations"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.success.clone(),
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );

    assert_eq!(result, Err(Ok(Error::InvalidFailureDestination)));
}

#[test]
fn test_create_vault_three_verifiers_threshold_two_settles() {
    let f = create_fixture();
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    let c = Address::generate(&f.env);
    let verifier_set = verifier_set_of(&f.env, &[a.clone(), b.clone(), c], 2);

    f.contract.create_vault(
        &String::from_str(&f.env, "v-mofn"),
        &f.creator,
        &verifier_set,
        &None::<Address>,
        &f.token,
        &1_000,
        &f.success,
        &f.failure,
        &2_000u64,
        &one_milestone(&f.env, 1_000, 1_100),
    );
    f.contract
        .stake(&String::from_str(&f.env, "v-mofn"), &f.creator);

    let vault_id = String::from_str(&f.env, "v-mofn");

    // One approval is not enough at threshold 2.
    f.contract
        .check_in(&vault_id, &a, &0, &evidence_hash(&f.env, 1));
    assert!(
        !f.contract
            .get_vault(&vault_id)
            .milestones
            .get(0)
            .unwrap()
            .verified
    );

    // A second approval from the same verifier must be rejected.
    let duplicate = f
        .contract
        .try_check_in(&vault_id, &a, &0, &evidence_hash(&f.env, 2));
    assert_eq!(duplicate, Err(Ok(Error::AlreadyApproved)));

    // A distinct second verifier reaches the threshold.
    f.contract
        .check_in(&vault_id, &b, &0, &evidence_hash(&f.env, 2));
    assert!(
        f.contract
            .get_vault(&vault_id)
            .milestones
            .get(0)
            .unwrap()
            .verified
    );

    f.contract.claim(&vault_id, &f.creator);
    let settled = f.contract.get_vault(&vault_id);
    assert_eq!(settled.status, VaultStatus::Completed);
    assert_eq!(settled.staked, 0);
    assert_eq!(
        token::Client::new(&f.env, &f.token).balance(&f.success),
        1_000
    );
}

// ─── 15. admin_resolve terminal settlement (#1708) ───────────────────

#[test]
fn test_admin_resolve_completed_transfers_to_success() {
    let s = setup(&[100], &[1_000]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.admin_dispute(&s.vault_id, &s.creator);

    s.contract
        .admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Completed);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);
    assert_eq!(vault.staked, 0);
    assert_eq!(
        token::Client::new(&s.env, &s.token).balance(&s.success),
        1_000
    );
}

#[test]
fn test_admin_resolve_failed_transfers_remaining_to_failure() {
    let s = setup(&[100, 200], &[400, 600]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify and release the first milestone; `staked` drops to 600.
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    s.contract.admin_dispute(&s.vault_id, &s.creator);
    s.contract
        .admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Failed);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 600);
    assert_eq!(token_client.balance(&s.success), 400);
}

#[test]
fn test_admin_resolve_active_moves_no_funds() {
    let s = setup(&[100], &[1_000]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.admin_dispute(&s.vault_id, &s.creator);

    s.contract
        .admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Active);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 1_000);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 0);
    assert_eq!(token_client.balance(&s.failure), 0);
}

#[test]
fn test_admin_resolve_paused_terminal_rejected() {
    let s = setup(&[100], &[1_000]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.admin_dispute(&s.vault_id, &s.creator);
    s.contract.emergency_pause(&s.vault_id, &s.creator);

    // Returning to Active is still allowed while paused: it moves no funds.
    s.contract
        .admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Active);
    assert_eq!(
        s.contract.get_vault(&s.vault_id).status,
        VaultStatus::Active
    );

    s.contract.admin_dispute(&s.vault_id, &s.creator);
    let blocked = s
        .contract
        .try_admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Completed);
    assert_eq!(blocked, Err(Ok(Error::Paused)));

    let still_disputed = s.contract.get_vault(&s.vault_id);
    assert_eq!(still_disputed.status, VaultStatus::Disputed);
    assert_eq!(still_disputed.staked, 1_000);

    // Unpause, then the same resolution settles normally.
    s.contract.emergency_unpause(&s.vault_id, &s.creator);
    s.contract
        .admin_resolve(&s.vault_id, &s.creator, &VaultStatus::Completed);
    assert_eq!(
        token::Client::new(&s.env, &s.token).balance(&s.success),
        1_000
    );
}

// Test-only SEP-41-like token that can be told to panic on `transfer`, used to
// prove the CEI ordering in `admin_resolve`: a failed transfer must not leave a
// terminal vault whose `staked` balance is still set.
#[contracttype]
enum MockTokenKey {
    Balance(Address),
    PanicOnTransfer,
}

#[contract]
struct PanicToken;

#[contractimpl]
impl PanicToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = MockTokenKey::Balance(to);
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
    }

    pub fn set_panic_on_transfer(env: Env, panic: bool) {
        env.storage()
            .instance()
            .set(&MockTokenKey::PanicOnTransfer, &panic);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockTokenKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let panics: bool = env
            .storage()
            .instance()
            .get(&MockTokenKey::PanicOnTransfer)
            .unwrap_or(false);
        if panics {
            panic!("mock token transfer failure");
        }

        let from_key = MockTokenKey::Balance(from);
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_balance >= amount);

        let to_key = MockTokenKey::Balance(to);
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&from_key, &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&to_key, &(to_balance + amount));
    }
}

#[test]
fn test_admin_resolve_transfer_failure_is_recoverable() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);

    let token_id = env.register(PanicToken, ());
    let token_client = PanicTokenClient::new(&env, &token_id);
    token_client.mint(&creator, &1_000);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-cei");
    let verifier_set = verifier_set_of(&env, &[verifier], 1);

    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token_id,
        &1_000,
        &success,
        &failure,
        &2_000u64,
        &one_milestone(&env, 1_000, 1_100),
    );
    contract.stake(&vault_id, &creator);
    contract.admin_dispute(&vault_id, &creator);

    token_client.set_panic_on_transfer(&true);
    let failed = contract.try_admin_resolve(&vault_id, &creator, &VaultStatus::Completed);
    assert!(failed.is_err());

    // The failed transfer must not leave a terminal vault with funds stranded:
    // the vault stays Disputed with its stake intact, so the guardian can retry.
    let after_failure = contract.get_vault(&vault_id);
    assert_eq!(after_failure.status, VaultStatus::Disputed);
    assert_eq!(after_failure.staked, 1_000);

    token_client.set_panic_on_transfer(&false);
    contract.admin_resolve(&vault_id, &creator, &VaultStatus::Completed);

    let settled = contract.get_vault(&vault_id);
    assert_eq!(settled.status, VaultStatus::Completed);
    assert_eq!(settled.staked, 0);
    assert_eq!(token_client.balance(&success), 1_000);
}
