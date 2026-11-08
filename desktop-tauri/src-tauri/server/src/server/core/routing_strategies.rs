//! Pure pool ordering. Runtime observations are passed in; previews never advance a round.

use std::cmp::Ordering;

#[derive(Clone, Debug, Default)]
pub(crate) struct Seat {
    pub key: String,
    pub known: bool,
    pub used: f64,
    pub renewals: Vec<i64>,
    pub lapse: Option<i64>,
    pub balance: Option<f64>,
    pub balance_unit: String,
    pub tokens: f64,
    pub pace: Option<f64>,
    pub ttft_ms: Option<f64>,
    pub tps: Option<f64>,
    pub free: bool,
    pub weight: usize,
}

fn number(a: f64, b: f64) -> Ordering { a.partial_cmp(&b).unwrap_or(Ordering::Equal) }
fn tier(seat: &Seat) -> u8 {
    if !seat.known { 0 } else if seat.used >= 98.0 { 2 } else if seat.used >= 90.0 { 1 } else { 0 }
}
fn known_first<T: Ord>(a: Option<T>, b: Option<T>) -> Ordering {
    match (a, b) { (Some(a), Some(b)) => a.cmp(&b), (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater, _ => Ordering::Equal }
}

// Sort each wallet currency only inside the positions that currency already owns.
// A pairwise comparator that compares only matching currencies is not transitive.
fn wallet_positions(seats: &[Seat], by_tokens: bool) -> Vec<usize> {
    let mut indexes: Vec<_> = (0..seats.len()).collect();
    if by_tokens { indexes.sort_by(|&a, &b| number(seats[a].tokens, seats[b].tokens)); }
    let mut groups: std::collections::BTreeMap<&str, Vec<usize>> = Default::default();
    for (position, &index) in indexes.iter().enumerate() {
        if seats[index].balance.is_some() && !seats[index].balance_unit.is_empty() {
            groups.entry(&seats[index].balance_unit).or_default().push(position);
        }
    }
    for positions in groups.values() {
        let mut members: Vec<_> = positions.iter().map(|&position| indexes[position]).collect();
        members.sort_by(|&a, &b| number(seats[b].balance.unwrap_or(0.0), seats[a].balance.unwrap_or(0.0)));
        for (&position, index) in positions.iter().zip(members) { indexes[position] = index; }
    }
    let mut rank = vec![0; seats.len()];
    for (position, index) in indexes.into_iter().enumerate() { rank[index] = position; }
    rank
}

struct WeightedCycle { weights: Vec<i64>, current: Vec<i64>, heads: Vec<usize> }
// Memoization does not advance a round: callers supply its index. Keep at most 16
// distinct pools and one finite cycle per pool, including concurrent previews.
fn weighted_head(seats: &[Seat], round: usize) -> usize {
    use std::sync::{Mutex, OnceLock};
    static CYCLES: OnceLock<Mutex<Vec<(String, WeightedCycle)>>> = OnceLock::new();
    let mut weights: Vec<_> = seats.iter().map(|seat| seat.weight.clamp(1, 1000) as i64).collect();
    fn gcd(mut a: i64, mut b: i64) -> i64 { while b != 0 { (a, b) = (b, a % b); } a }
    let common = weights.iter().copied().reduce(gcd).unwrap_or(1).max(1);
    for weight in &mut weights { *weight /= common; }
    let total: i64 = weights.iter().sum();
    let key = seats.iter().zip(&weights).map(|(seat, weight)| format!("{}:{}:{weight}", seat.key.len(), seat.key)).collect::<Vec<_>>().join("|");
    let mut cycles = CYCLES.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner());
    let index = if let Some(index) = cycles.iter().position(|(known, _)| known == &key) { index } else {
        if cycles.len() >= 16 { cycles.remove(0); }
        cycles.push((key, WeightedCycle { current: vec![0; weights.len()], weights, heads: Vec::new() }));
        cycles.len() - 1
    };
    let cycle = &mut cycles[index].1;
    let target = round % total.max(1) as usize;
    while cycle.heads.len() <= target {
        let mut best = 0;
        for index in 0..cycle.weights.len() {
            cycle.current[index] += cycle.weights[index];
            if cycle.current[index] > cycle.current[best] { best = index; }
        }
        cycle.current[best] -= total;
        cycle.heads.push(best);
    }
    cycle.heads[target]
}

pub(crate) fn order(strategy: &str, seats: &[Seat], round: Option<usize>) -> Vec<usize> {
    let mut indexes: Vec<_> = (0..seats.len()).collect();
    if indexes.len() < 2 { return indexes; }
    match strategy {
        "rotate" => { let start = round.unwrap_or(0) % indexes.len(); indexes.rotate_left(start); }
        "weight" => { let best = weighted_head(seats, round.unwrap_or(0)); indexes.remove(best); indexes.insert(0, best); }
        "free" => indexes.sort_by_key(|&index| !seats[index].free),
        "fast" => {
            let mut measured: Vec<_> = indexes.iter().copied().filter(|&index| tier(&seats[index]) < 2 && seats[index].ttft_ms.is_some_and(|value| value > 0.0)).collect();
            let unknown: Vec<_> = indexes.iter().copied().filter(|&index| tier(&seats[index]) < 2 && !seats[index].ttft_ms.is_some_and(|value| value > 0.0)).collect();
            let spent: Vec<_> = indexes.iter().copied().filter(|&index| tier(&seats[index]) == 2).collect();
            let mut paces: Vec<_> = measured.iter().filter_map(|&index| seats[index].tps.filter(|value| *value > 0.0)).collect();
            paces.sort_by(|a,b| number(*a,*b));
            let median = paces.get(paces.len()/2).copied().unwrap_or(0.0);
            let estimates: Vec<_> = seats.iter().map(|seat| {
                let pace = seat.tps.filter(|value| *value > 0.0).unwrap_or(median);
                seat.ttft_ms.unwrap_or(0.0) + if pace > 0.0 { 200_000.0 / pace } else { 0.0 }
            }).collect();
            measured.sort_by(|&a,&b| number(estimates[a],estimates[b]));
            let mut bands = vec![0; seats.len()]; let mut band = 0; let mut top = 0.0;
            for (position,&index) in measured.iter().enumerate() {
                if position == 0 { top = estimates[index]; }
                else if estimates[index] > top * 1.1 { band += 1; top = estimates[index]; }
                bands[index] = band;
            }
            measured.sort_by_key(|&index| (bands[index],index));
            let probe = round.filter(|round| (round + 1) % 5 == 0 && !measured.is_empty() && !unknown.is_empty())
                .map(|round| unknown[(round / 5) % unknown.len()]);
            indexes = measured.into_iter().chain(unknown).chain(spent).collect();
            if let Some(probe) = probe { indexes.retain(|index| *index != probe); indexes.insert(0,probe); }
        },
        "smart" | "least-used" | "pace" => {
            let wallet = wallet_positions(seats, strategy != "smart");
            indexes.sort_by(|&a, &b| {
                let (left, right) = (&seats[a], &seats[b]);
                tier(left).cmp(&tier(right)).then_with(|| {
                    if tier(left) > 0 || strategy == "least-used" {
                        number(if left.known { left.used } else { 0.0 }, if right.known { right.used } else { 0.0 })
                    } else if strategy == "smart" {
                        let mut renewal = Ordering::Equal;
                        for index in 0..left.renewals.len().max(right.renewals.len()) {
                            renewal = known_first(left.renewals.get(index).copied(), right.renewals.get(index).copied());
                            if renewal != Ordering::Equal { break; }
                        }
                        renewal.then_with(|| known_first(left.lapse, right.lapse))
                    } else {
                        number(right.pace.unwrap_or(0.0), left.pace.unwrap_or(0.0))
                    }
                }).then_with(|| wallet[a].cmp(&wallet[b]))
            });
        }
        _ => {}
    }
    indexes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(key: &str) -> Seat { Seat { key: key.into(), ..Default::default() } }

    #[test]
    fn smart_prefers_renewal_without_comparing_different_wallet_units() {
        let mut a = seat("a"); a.known = true; a.used = 20.0; a.renewals = vec![200];
        let mut b = seat("b"); b.known = true; b.used = 30.0; b.renewals = vec![100];
        assert_eq!(order("smart", &[a.clone(), b.clone()], None), vec![1, 0]);
        a.renewals.clear(); b.renewals.clear(); a.balance = Some(1000.0); b.balance = Some(1.0);
        a.balance_unit = "vendor-a:credits".into(); b.balance_unit = "vendor-b:USD".into();
        assert_eq!(order("smart", &[b, a], None), vec![0, 1]);
    }

    #[test]
    fn least_used_and_pace_use_observed_facts() {
        let mut a = seat("a"); a.tokens = 1000.0; a.pace = Some(1.0);
        let mut b = seat("b"); b.tokens = 10.0; b.pace = Some(5.0);
        assert_eq!(order("least-used", &[a.clone(), b.clone()], None), vec![1, 0]);
        assert_eq!(order("pace", &[a, b], None), vec![1, 0]);
    }

    #[test]
    fn free_and_speed_rank_real_evidence_and_keep_unknowns_stable() {
        let mut a = seat("a"); a.ttft_ms = Some(800.0);
        let mut b = seat("b"); b.ttft_ms = Some(200.0); b.free = true;
        assert_eq!(order("free", &[a.clone(), b.clone()], None), vec![1, 0]);
        assert_eq!(order("fast", &[a, b], None), vec![1, 0]);
        assert_eq!(order("fast", &[seat("x"), seat("y")], None), vec![0, 1]);
    }

    #[test]
    fn weighted_round_is_smooth_and_preview_does_not_consume_it() {
        let mut a = seat("a"); a.weight = 3;
        let mut b = seat("b"); b.weight = 1;
        let seats = [a, b];
        let heads: Vec<_> = (0..4).map(|round| order("weight", &seats, Some(round))[0]).collect();
        assert_eq!(heads, vec![0, 0, 1, 0]);
        assert_eq!(order("weight", &seats, None), order("weight", &seats, None));
    }

    #[test]
    fn speed_keeps_ten_percent_bands_stable_and_probes_unknowns_every_fifth_round() {
        let mut a = seat("band-a"); a.ttft_ms = Some(105.0);
        let mut b = seat("band-b"); b.ttft_ms = Some(100.0);
        let unknown = seat("band-unknown");
        assert_eq!(order("fast", &[a.clone(),b.clone()],Some(0)), [0,1]);
        assert_eq!(order("fast", &[a.clone(),b.clone(),unknown.clone()],Some(3))[0], 0);
        assert_eq!(order("fast", &[a.clone(),b.clone(),unknown.clone()],Some(4))[0], 2);
        assert_eq!(order("fast", &[a,b,unknown],None)[0], 0);
    }

    #[test]
    fn speed_estimates_a_short_reply_instead_of_only_the_first_token() {
        let mut a = seat("slow-writing"); a.ttft_ms = Some(100.0); a.tps = Some(10.0);
        let mut b = seat("fast-writing"); b.ttft_ms = Some(500.0); b.tps = Some(100.0);
        assert_eq!(order("fast", &[a,b],None), [1,0]);
    }

    #[test]
    fn exhausted_routes_follow_healthy_routes_and_unknown_strategy_is_stable() {
        let mut a = seat("a"); a.known = true; a.used = 100.0;
        assert_eq!(order("smart", &[a.clone(), seat("b")], None), vec![1, 0]);
        assert_eq!(order("not-installed", &[a, seat("b")], Some(6)), vec![0, 1]);
    }
}
