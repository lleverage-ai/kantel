//! The filesystem provider contract (src/workspace/contract.rs) against both kinds of provider: Kantel's manifest per
//! command, and the reference persistent workspace with compare-and-swap commits and unknown outcomes.

use kantel_isolate::workspace::contract::{self, subjects};

#[tokio::test]
async fn the_manifest_provider_keeps_the_contract() {
    contract::common(&subjects::Manifest::default()).await;
}

#[tokio::test]
async fn the_reference_persistent_provider_keeps_the_contract() {
    let subject = subjects::Record::default();
    contract::common(&subject).await;
    contract::persistent(&subject).await;
}
