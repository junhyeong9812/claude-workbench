use serde::Serialize;

use super::{op_in_progress, resolve_commit, run_git, run_git_bytes, run_git_io};

/// Reword the HEAD commit with a FULL (multi-line) message — the editor path that
/// preserves body/trailers. Safety guards: `hash` must be HEAD and the index must be
/// clean (so staged changes aren't folded in). Rewrites HEAD's hash (recoverable via
/// reflog); UI confirms.
pub fn reword(cwd: &str, hash: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("커밋 메시지가 비어 있습니다".to_string());
    }
    if resolve_commit(cwd, "HEAD")? != resolve_commit(cwd, hash)? {
        return Err("HEAD 커밋만 수정할 수 있습니다".to_string());
    }
    if run_git(cwd, &["diff", "--cached", "--quiet"]).is_err() {
        return Err("스테이지된 변경이 있습니다 — 먼저 커밋/언스테이지 후 수정하세요".to_string());
    }
    run_git(cwd, &["commit", "--amend", "-m", message])
}

/// Undo the last commit, keeping its changes staged (`git reset --soft HEAD~1`).
/// Non-destructive: the working tree is untouched and the change set survives in the
/// index. Guards (codex): `hash` must still BE HEAD (no soft-resetting a different
/// commit if HEAD moved), there must be a parent (not the root commit), and no
/// merge/revert/cherry-pick/rebase may be in progress. Recoverable via reflog.
pub fn uncommit(cwd: &str, hash: &str) -> Result<String, String> {
    if resolve_commit(cwd, "HEAD")? != resolve_commit(cwd, hash)? {
        return Err("HEAD 커밋만 취소할 수 있습니다".to_string());
    }
    if op_in_progress(cwd) {
        return Err("진행 중인 머지/되돌리기 작업이 있습니다 — 먼저 그것을 끝내세요".to_string());
    }
    if run_git(cwd, &["rev-parse", "--verify", "HEAD~1"]).is_err() {
        return Err("부모가 없는 커밋(최초 커밋)은 취소할 수 없습니다".to_string());
    }
    run_git(cwd, &["reset", "--soft", "HEAD~1"])
}

/// Revert a commit (`git revert --no-edit <hash>`) — a NEW commit undoing it
/// (non-destructive). `hash` must resolve to a single commit. On conflict it leaves
/// REVERT_HEAD (status.reverting) for [`revert_abort`] / [`revert_continue`].
pub fn revert(cwd: &str, hash: &str) -> Result<String, String> {
    resolve_commit(cwd, hash)?;
    run_git(cwd, &["revert", "--no-edit", hash])
}

/// Abort an in-progress revert (`git revert --abort`).
pub fn revert_abort(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["revert", "--abort"])
}

/// Conclude a revert after conflicts are resolved + staged — committing while
/// REVERT_HEAD exists clears it (no editor; mirrors merge_continue).
pub fn revert_continue(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["commit", "--no-edit"])
}

/// Result of a reset: the auto-created backup ref (for recovery) + git's output.
#[derive(Debug, Clone, Serialize)]
pub struct ResetResult {
    /// Recovery ref at the pre-reset HEAD (restores the commit position).
    pub backup_ref: String,
    /// True if a `--hard` on a dirty tree auto-stashed tracked changes first (those
    /// are NOT in `backup_ref` — recover with `git stash pop`).
    pub stashed: bool,
    pub output: String,
}

/// Create a recovery ref at the current HEAD before a history rewrite, so the
/// commit position is always restorable (`git reset --hard <returned ref>`). Named
/// per branch + nanos + short HEAD so repeat ops never collide (dual-review). Errors
/// on a detached HEAD (no branch) or a ref-write failure — callers MUST abort the
/// rewrite if this fails (no backup ⇒ don't proceed). NOTE: a ref only points at a
/// commit; it does NOT preserve uncommitted working-tree/index changes (see reset_to).
pub fn backup_ref(cwd: &str) -> Result<String, String> {
    let branch = run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "분리된 HEAD에서는 리셋을 지원하지 않습니다".to_string())?;
    if branch.is_empty() {
        return Err("현재 브랜치를 확인할 수 없습니다".to_string());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let short = run_git(cwd, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let name = format!("refs/backup/{branch}-{nanos}-{short}");
    run_git(cwd, &["update-ref", &name, "HEAD"])?;
    // Cap accumulation: backup refs pile up across every reset/reword, blocking gc
    // and cluttering the ref space. Keep only the most recent BACKUP_KEEP, best-effort
    // — a prune failure must NOT fail the rewrite (the new backup already exists).
    // `name` is passed as PROTECTED so the just-created recovery ref is never deleted,
    // even if a clock-skewed / future-timestamped older ref sorts above it (codex).
    prune_backup_refs(cwd, BACKUP_KEEP, &name);
    Ok(name)
}

/// How many `refs/backup/*` to retain (the most recent N by creation). Generous so
/// recovery for recent destructive ops stays available. Pruned backups are no longer
/// referenced, so their commits may become unreachable and gc-eligible.
const BACKUP_KEEP: usize = 20;

/// Parse the creation `nanos` out of a backup ref name
/// `refs/backup/<branch>-<nanos>-<short>`. `nanos` and `short` are the LAST two
/// `-`-separated segments (neither contains `-`), so this is robust to branches that
/// themselves contain `-` or `/`. Returns `None` for a name that doesn't match our
/// format (e.g. a user-created `refs/backup/*`), which the caller leaves untouched.
fn backup_ref_nanos(refname: &str) -> Option<u128> {
    let mut it = refname.rsplitn(3, '-'); // [short, nanos, branch...]
    let short = it.next();
    let nanos = it.next().and_then(|s| s.parse::<u128>().ok());
    // Require both a short segment and a parseable nanos → matches our naming.
    short.filter(|s| !s.is_empty()).and(nanos)
}

/// Keep the `keep` most-recent app-created `refs/backup/*` (by embedded nanos), always
/// keeping `protect` (the just-created ref) regardless of its timestamp, and delete the
/// rest. Only refs matching our `<branch>-<nanos>-<short>` format are candidates — a
/// user's own `refs/backup/*` (no parseable nanos) is left alone (codex). Best-effort:
/// every failure is swallowed so the caller's rewrite never breaks.
fn prune_backup_refs(cwd: &str, keep: usize, protect: &str) {
    let listed = match run_git(cwd, &["for-each-ref", "--format=%(refname)", "refs/backup/"]) {
        Ok(o) => o,
        Err(_) => return,
    };
    // Candidates = our-format refs, excluding the protected (just-created) one.
    let mut refs: Vec<(u128, String)> = listed
        .lines()
        .filter(|l| !l.is_empty() && *l != protect)
        .filter_map(|l| backup_ref_nanos(l).map(|n| (n, l.to_string())))
        .collect();
    // `protect` is always retained, so we keep up to keep-1 of the others.
    let keep_rest = keep.saturating_sub(1);
    if refs.len() <= keep_rest {
        return;
    }
    refs.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, r) in refs.into_iter().skip(keep_rest) {
        let _ = run_git(cwd, &["update-ref", "-d", &r]);
    }
}

/// Reset the current branch to `hash` in `mode` (soft|mixed|hard). For `hard` this
/// discards index + working tree, so — since the backup ref only restores commits,
/// not uncommitted changes (dual-review CRITICAL) — a dirty tree is auto-stashed
/// FIRST (tracked changes; untracked survive `reset --hard`). The backup ref is also
/// created first; if either safety step fails the reset is NOT performed. Refuses
/// during a sequencer op. `mode` is whitelisted; the commit is pre-resolved.
pub fn reset_to(cwd: &str, hash: &str, mode: &str) -> Result<ResetResult, String> {
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err("잘못된 reset 모드입니다".to_string()),
    };
    let target = resolve_commit(cwd, hash)?; // single commit; use the resolved hash
    if op_in_progress(cwd) {
        return Err("진행 중인 머지/되돌리기 작업이 있습니다 — 먼저 끝내세요".to_string());
    }
    let backup_ref = backup_ref(cwd)?; // no backup ⇒ no reset
    // `reset --hard` would discard uncommitted tracked changes — AND can delete an
    // untracked file that obstructs a tracked path in the target commit — none of
    // which the backup ref restores. So stash everything dirty (incl. untracked;
    // `git status --porcelain` covers both, ignored files excluded) FIRST, so a pop
    // recovers all of it (re-review CRITICAL).
    let mut stashed = false;
    if flag == "--hard" {
        let dirty = !run_git(cwd, &["status", "--porcelain"])
            .unwrap_or_default()
            .is_empty();
        if dirty {
            run_git(cwd, &["stash", "push", "--include-untracked", "-m", "pre-reset (auto)"])?;
            stashed = true;
        }
    }
    // If the reset itself fails after a successful stash, make sure the user learns
    // their changes were moved to the stash (re-review Medium).
    let output = run_git(cwd, &["reset", flag, &target]).map_err(|e| {
        if stashed {
            format!("{e}\n(미커밋 변경은 'pre-reset (auto)'로 stash됨 — git stash list 확인)")
        } else {
            e
        }
    })?;
    Ok(ResetResult {
        backup_ref,
        stashed,
        output,
    })
}

/// Result of a past-commit reword — mirrors [`ResetResult`] for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct RewordResult {
    /// Recovery ref at the pre-reword HEAD (`git reset --hard <ref>` restores it).
    pub backup_ref: String,
    /// Always false: this rewrite never touches the working tree, so nothing is
    /// auto-stashed. Kept for shape-parity with [`ResetResult`] / the frontend.
    pub stashed: bool,
    /// The new HEAD hash after the rewrite.
    pub output: String,
}

/// Parent hashes of a commit (`%P`) — empty for the root commit.
fn commit_parents(cwd: &str, commit: &str) -> Result<Vec<String>, String> {
    let p = run_git(cwd, &["log", "-1", "--format=%P", commit])?;
    Ok(p.split_whitespace().map(|s| s.to_string()).collect())
}

/// A commit's message as RAW BYTES, extracted from `git cat-file commit <hash>`
/// (the bytes after the first blank line that separates headers from the message).
/// Byte-exact — preserves empty messages, intentional trailing blank lines, and
/// non-UTF-8 content, which a `%B` + UTF-8 string round-trip would mangle (codex
/// audit). `hash` is a resolved oid from our own `rev-list`, never user input.
fn commit_message_bytes(cwd: &str, hash: &str) -> Result<Vec<u8>, String> {
    let obj = run_git_bytes(cwd, &["cat-file", "commit", hash])?;
    match obj.windows(2).position(|w| w == b"\n\n") {
        Some(i) => Ok(obj[i + 2..].to_vec()),
        None => Ok(Vec::new()),
    }
}

/// Rebuild a single commit object: SAME tree as `src`, the given `parents`, the
/// given `message` BYTES (via stdin `-F -`, written verbatim — empty/multi-line/
/// trailing-blank/non-UTF-8 all preserved), and `src`'s AUTHOR identity via
/// `GIT_AUTHOR_*`. The committer becomes the current user (same as rebase/
/// cherry-pick). `commit-tree` is plumbing, so no commit hooks run and nothing is
/// GPG-signed. The caller owns message shaping: descendants pass their exact bytes
/// (via [`commit_message_bytes`]) for byte-for-byte fidelity; the target passes the
/// user's new message normalized to a single trailing newline.
fn commit_tree(cwd: &str, src: &str, parents: &[String], message: &[u8]) -> Result<String, String> {
    let an = run_git(cwd, &["log", "-1", "--format=%an", src])?;
    let ae = run_git(cwd, &["log", "-1", "--format=%ae", src])?;
    let ad = run_git(cwd, &["log", "-1", "--format=%aI", src])?; // strict ISO-8601
    let mut args: Vec<String> = vec!["commit-tree".to_string(), format!("{src}^{{tree}}")];
    for p in parents {
        args.push("-p".to_string());
        args.push(p.clone());
    }
    args.push("-F".to_string());
    args.push("-".to_string()); // read message from stdin
    let argv: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_io(
        cwd,
        &argv,
        &[
            ("GIT_AUTHOR_NAME", an.as_str()),
            ("GIT_AUTHOR_EMAIL", ae.as_str()),
            ("GIT_AUTHOR_DATE", ad.as_str()),
        ],
        Some(message),
    )
}

/// Reword (change the message of) a possibly-NON-HEAD commit by rebuilding the
/// commit objects from `target` up to HEAD with `git commit-tree`, then atomically
/// repointing the branch with a compare-and-swap `update-ref`. Unlike rebase or
/// cherry-pick, this NEVER checks out, stashes, or touches the working tree: every
/// rebuilt commit reuses its original tree, so only messages (and the resulting
/// commit hashes) change — uncommitted/staged changes survive untouched. Author
/// identity is preserved per commit (committer becomes the current user, as rebase).
///
/// Guards (history-rewrite safety — codex design review): `hash` resolves to a
/// single commit and is an ANCESTOR of HEAD (else `<target>..HEAD` would replay
/// unrelated commits); the range has NO merge commit (a linear replay can't carry
/// a second parent); no sequencer op is in progress; the message is non-empty; HEAD
/// is on a branch (not detached); and no `refs/replace/*` exist (they'd silently
/// alter the rewritten graph). The final CAS rejects if the branch moved meanwhile,
/// leaving the repo + working tree intact and the backup ref in place.
pub fn reword_past(cwd: &str, hash: &str, message: &str) -> Result<RewordResult, String> {
    if message.trim().is_empty() {
        return Err("커밋 메시지가 비어 있습니다".to_string());
    }
    let target = resolve_commit(cwd, hash)?; // single commit; rejects ranges & leading-dash
    let branch = run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "분리된 HEAD에서는 수정을 지원하지 않습니다".to_string())?;
    if branch.is_empty() {
        return Err("현재 브랜치를 확인할 수 없습니다".to_string());
    }
    // Snapshot the HEAD endpoint ONCE and drive every graph op (ancestry, merge
    // scan, descendant list) off `orig_head` — never a re-read literal `HEAD` — so
    // a concurrent move can't make the validated/replayed/CAS'd commit sets diverge
    // (codex review). The final CAS also pins `orig_head`.
    let orig_head = resolve_commit(cwd, "HEAD")?;
    if op_in_progress(cwd) {
        return Err("진행 중인 머지/되돌리기 작업이 있습니다 — 먼저 끝내세요".to_string());
    }
    // `<target>..orig_head` = "reachable from orig_head but not from target". If
    // target isn't an ancestor, that set is the wrong commits — so require ancestry.
    if run_git(cwd, &["merge-base", "--is-ancestor", &target, &orig_head]).is_err() {
        return Err("현재 브랜치의 조상 커밋만 수정할 수 있습니다".to_string());
    }
    // A linear commit-tree replay carries one parent forward; a merge commit in the
    // replayed range would lose its other parent. Refuse rather than corrupt.
    if !run_git(cwd, &["rev-list", "--merges", &format!("{target}..{orig_head}")])?.is_empty() {
        return Err("범위 안에 머지 커밋이 있어 수정할 수 없습니다".to_string());
    }
    // Replace refs would make commit-tree/rev-list operate on a substituted object
    // graph, silently corrupting the rewrite. This is a safety check, so fail CLOSED
    // if the query itself errors (codex review) — never proceed on an unknown state.
    if !run_git(cwd, &["for-each-ref", "refs/replace/"])?.is_empty() {
        return Err("refs/replace/* 가 있어 안전하게 수정할 수 없습니다".to_string());
    }
    let backup_ref = backup_ref(cwd)?; // no backup ⇒ no rewrite

    // Rebuild target with its ORIGINAL parents + the NEW message. The user's message
    // is normalized to exactly one trailing newline so the object is well-formed.
    let mut target_msg: Vec<u8> = message.trim_end_matches('\n').as_bytes().to_vec();
    target_msg.push(b'\n');
    let new_target = commit_tree(cwd, &target, &commit_parents(cwd, &target)?, &target_msg)?;
    // Replay each descendant (oldest first), preserving tree/message/author; each
    // has a single parent (merges already refused) → map it to the prior new commit.
    // Feed the descendant's EXACT message bytes (via cat-file) so its message is
    // byte-for-byte preserved (empty / trailing-blank / non-UTF-8 included).
    let desc = run_git(cwd, &["rev-list", "--reverse", &format!("{target}..{orig_head}")])?;
    let mut new_head = new_target;
    for c in desc.lines().filter(|l| !l.is_empty()) {
        let msg = commit_message_bytes(cwd, c)?;
        new_head = commit_tree(cwd, c, std::slice::from_ref(&new_head), &msg)?;
    }

    // Atomically repoint the branch only if it still points at orig_head (CAS) —
    // blocks clobbering a concurrent advance from another process/worktree. On
    // failure nothing moved: repo + working tree intact, recover via backup_ref.
    run_git(
        cwd,
        &[
            "update-ref",
            &format!("refs/heads/{branch}"),
            &new_head,
            &orig_head,
        ],
    )
    .map_err(|e| {
        format!("브랜치가 그 사이 이동했습니다 — 수정을 취소했습니다 (원본 보존: {backup_ref})\n{e}")
    })?;

    Ok(RewordResult {
        backup_ref,
        stashed: false,
        output: new_head,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_git_{tag}_{nanos}_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // ===================================================================
    // reword_past — integration tests. Assert OBSERVABLE git behavior via
    // real `git` inspection, independent of the commit-tree mechanism.
    // Invariant numbers refer to task.md §1.
    // ===================================================================

    /// Fresh repo with a deterministic identity; gpg signing off so commits never
    /// block on a key.
    fn init_repo(tag: &str) -> std::path::PathBuf {
        let p = temp_dir(tag);
        let cwd = p.to_string_lossy().to_string();
        run_git(&cwd, &["init", "-q"]).unwrap();
        run_git(&cwd, &["config", "user.name", "Committer"]).unwrap();
        run_git(&cwd, &["config", "user.email", "committer@example.com"]).unwrap();
        run_git(&cwd, &["config", "commit.gpgsign", "false"]).unwrap();
        p
    }

    /// Commit a new file with an explicit AUTHOR (committer stays the repo identity)
    /// so author-preservation is observable across the rewrite.
    fn mk_commit(cwd: &str, file: &str, content: &str, msg: &str, author: &str) {
        std::fs::write(std::path::Path::new(cwd).join(file), content).unwrap();
        run_git(cwd, &["add", file]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", msg, &format!("--author={author}")]).unwrap();
    }

    fn rev(cwd: &str, r: &str) -> String {
        run_git(cwd, &["rev-parse", r]).unwrap()
    }
    /// Tree (snapshot) object id of a ref — content-addressed, so equality means a
    /// byte-identical tree regardless of the surrounding commit hash.
    fn tree(cwd: &str, r: &str) -> String {
        run_git(cwd, &["rev-parse", &format!("{r}^{{tree}}")]).unwrap()
    }
    fn body(cwd: &str, r: &str) -> String {
        run_git(cwd, &["log", "-1", "--format=%B", r]).unwrap()
    }
    /// RAW message BYTES — catches trailing-newline / empty / non-UTF-8 corruption
    /// that the trimming `body()` would mask (dual review + codex audit).
    fn raw_msg(cwd: &str, r: &str) -> Vec<u8> {
        commit_message_bytes(cwd, r).unwrap()
    }
    /// Author identity AND date — so dropping `GIT_AUTHOR_DATE` would fail a test.
    fn who(cwd: &str, r: &str) -> String {
        run_git(cwd, &["log", "-1", "--format=%an <%ae> %aI", r]).unwrap()
    }
    fn count(cwd: &str) -> String {
        run_git(cwd, &["rev-list", "--count", "HEAD"]).unwrap()
    }
    fn branch_of(cwd: &str) -> String {
        run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap()
    }

    /// Inv 4: no sequencer/replay state left behind, and HEAD is attached.
    fn assert_clean_attached(cwd: &str, branch: &str) {
        assert!(!op_in_progress(cwd), "no merge/cherry-pick/rebase in progress");
        for f in [".git/CHERRY_PICK_HEAD", ".git/sequencer", ".git/rebase-merge", ".git/rebase-apply"] {
            assert!(
                !std::path::Path::new(cwd).join(f).exists(),
                "leftover sequencer state: {f}"
            );
        }
        assert_eq!(branch_of(cwd), branch, "HEAD still attached to its branch");
    }

    // ---- happy path: middle commit of a 4-commit linear repo (inv 1,2,3,4) ----
    #[test]
    fn reword_past_middle_commit_preserves_all_trees_and_descendants() {
        let dir = init_repo("rw_mid");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "c1 root", "Alice <a@x>");
        mk_commit(cwd, "b", "2", "c2 middle", "Bob <b@x>");
        mk_commit(cwd, "c", "3", "c3", "Carol <c@x>");
        mk_commit(cwd, "d", "4", "c4 head", "Dave <d@x>");
        let branch = branch_of(cwd);

        let target = rev(cwd, "HEAD~2"); // the middle commit c2
        let trees_before = [tree(cwd, "HEAD"), tree(cwd, "HEAD~1"), tree(cwd, "HEAD~2"), tree(cwd, "HEAD~3")];
        let who_before = [who(cwd, "HEAD"), who(cwd, "HEAD~1"), who(cwd, "HEAD~2"), who(cwd, "HEAD~3")];
        let head_msg_before = body(cwd, "HEAD");
        let h1_msg_before = body(cwd, "HEAD~1");
        let old_head = rev(cwd, "HEAD");

        let res = reword_past(cwd, &target, "c2 reworded message").expect("reword_past ok");

        // inv 3: a backup ref at the pre-op HEAD exists.
        assert!(res.backup_ref.starts_with("refs/backup/"), "backup ref namespace");
        assert_eq!(rev(cwd, &res.backup_ref), old_head, "backup ref = pre-op HEAD");
        assert!(!res.stashed, "commit-tree rewrite never stashes");

        assert_eq!(count(cwd), "4", "no commits added/dropped");
        // inv 1: ONLY the target message changed.
        assert_eq!(body(cwd, "HEAD~2"), "c2 reworded message", "target message changed");
        // inv 1+2: EVERY tree byte-identical at every position, authors preserved.
        for (i, r) in ["HEAD", "HEAD~1", "HEAD~2", "HEAD~3"].iter().enumerate() {
            assert_eq!(tree(cwd, r), trees_before[i], "tree preserved at {r}");
            assert_eq!(who(cwd, r), who_before[i], "author preserved at {r}");
        }
        // inv 2: descendant messages unchanged.
        assert_eq!(body(cwd, "HEAD"), head_msg_before, "descendant c4 msg unchanged");
        assert_eq!(body(cwd, "HEAD~1"), h1_msg_before, "descendant c3 msg unchanged");
        assert_clean_attached(cwd, &branch);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 2 (fidelity): descendant message bytes preserved EXACTLY ----
    // Covers the trailing-newline round-trip (masked by the trimming body() helper)
    // AND an empty-message descendant (codex audit edge: normalization would corrupt).
    #[test]
    fn reword_past_preserves_descendant_message_bytes() {
        let dir = init_repo("rw_msgbytes");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "target original", "A <a@x>");
        // descendant 1: multi-paragraph message (subject + blank + body).
        std::fs::write(std::path::Path::new(cwd).join("b"), "2").unwrap();
        run_git(cwd, &["add", "b"]).unwrap();
        run_git(
            cwd,
            &["commit", "-q", "-m", "desc subject", "-m", "desc body line", "--author=B <b@x>"],
        )
        .unwrap();
        // descendant 2: EMPTY message (must stay empty, not become "\n").
        std::fs::write(std::path::Path::new(cwd).join("c"), "3").unwrap();
        run_git(cwd, &["add", "c"]).unwrap();
        run_git(cwd, &["commit", "-q", "--allow-empty-message", "-m", "", "--author=C <c@x>"]).unwrap();

        let target = rev(cwd, "HEAD~2");
        let multi_before = raw_msg(cwd, "HEAD~1");
        let empty_before = raw_msg(cwd, "HEAD");
        assert!(multi_before.starts_with(b"desc subject"), "precondition: multi-paragraph");
        assert!(empty_before.is_empty(), "precondition: empty-message descendant");

        reword_past(cwd, &target, "target reworded").unwrap();

        assert_eq!(raw_msg(cwd, "HEAD~1"), multi_before, "multi-paragraph descendant bytes preserved");
        assert_eq!(raw_msg(cwd, "HEAD"), empty_before, "empty-message descendant stays empty");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 3: backup ref restores the ORIGINAL history ----
    #[test]
    fn reword_past_backup_ref_is_restorable() {
        let dir = init_repo("rw_backup");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "first", "A <a@x>");
        mk_commit(cwd, "b", "2", "second", "B <b@x>");
        mk_commit(cwd, "c", "3", "third head", "C <c@x>");

        let target = rev(cwd, "HEAD~1");
        let orig_msg = body(cwd, "HEAD~1");
        let res = reword_past(cwd, &target, "renamed second").unwrap();
        assert_eq!(body(cwd, "HEAD~1"), "renamed second");

        run_git(cwd, &["reset", "--hard", &res.backup_ref]).unwrap();
        assert_eq!(body(cwd, "HEAD~1"), orig_msg, "original history restored from backup ref");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- reword the ROOT commit (no parent) (inv 1,2) ----
    #[test]
    fn reword_past_root_commit_works_and_preserves_descendants() {
        let dir = init_repo("rw_root");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "root original", "A <a@x>");
        mk_commit(cwd, "b", "2", "child", "B <b@x>");
        mk_commit(cwd, "c", "3", "grandchild head", "C <c@x>");
        let branch = branch_of(cwd);

        let root = rev(cwd, "HEAD~2");
        let trees_before = [tree(cwd, "HEAD"), tree(cwd, "HEAD~1"), tree(cwd, "HEAD~2")];
        let child_msg = body(cwd, "HEAD~1");

        reword_past(cwd, &root, "root reworded").expect("root reword ok");

        assert_eq!(count(cwd), "3");
        assert_eq!(body(cwd, "HEAD~2"), "root reworded", "root message changed");
        assert!(run_git(cwd, &["rev-parse", "--verify", "HEAD~3"]).is_err(), "root still parentless");
        for (i, r) in ["HEAD", "HEAD~1", "HEAD~2"].iter().enumerate() {
            assert_eq!(tree(cwd, r), trees_before[i], "tree preserved at {r}");
        }
        assert_eq!(body(cwd, "HEAD~1"), child_msg, "descendant msg unchanged");
        assert_clean_attached(cwd, &branch);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- reword HEAD itself (target == HEAD, no descendants) (inv 1) ----
    #[test]
    fn reword_past_head_itself_works_with_no_descendants() {
        let dir = init_repo("rw_head");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        mk_commit(cwd, "b", "2", "head original", "B <b@x>");
        let branch = branch_of(cwd);

        let head = rev(cwd, "HEAD");
        let tree_before = tree(cwd, "HEAD");
        let who_before = who(cwd, "HEAD");

        reword_past(cwd, &head, "head reworded").expect("head reword ok");

        assert_eq!(count(cwd), "2", "no descendants added");
        assert_eq!(body(cwd, "HEAD"), "head reworded", "HEAD message changed");
        assert_eq!(tree(cwd, "HEAD"), tree_before, "HEAD tree preserved");
        assert_eq!(who(cwd, "HEAD"), who_before, "HEAD author preserved");
        assert_clean_attached(cwd, &branch);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv: uncommitted (dirty + staged) changes survive the rewrite ----
    // commit-tree never touches the working tree, so this is its key safety win.
    #[test]
    fn reword_past_preserves_uncommitted_changes() {
        let dir = init_repo("rw_dirty");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two head", "B <b@x>");
        let target = rev(cwd, "HEAD~1");

        // dirty: modify a tracked file + add an untracked one + stage a change.
        std::fs::write(std::path::Path::new(cwd).join("a"), "EDITED").unwrap();
        std::fs::write(std::path::Path::new(cwd).join("untracked"), "u").unwrap();
        std::fs::write(std::path::Path::new(cwd).join("b"), "STAGED").unwrap();
        run_git(cwd, &["add", "b"]).unwrap();
        let status_before = run_git(cwd, &["status", "--porcelain"]).unwrap();

        reword_past(cwd, &target, "one reworded").expect("reword ok with dirty tree");

        assert_eq!(body(cwd, "HEAD~1"), "one reworded", "reword applied");
        assert_eq!(
            run_git(cwd, &["status", "--porcelain"]).unwrap(),
            status_before,
            "working tree + index untouched by the rewrite"
        );
        assert_eq!(std::fs::read_to_string(std::path::Path::new(cwd).join("a")).unwrap(), "EDITED");
        assert_eq!(std::fs::read_to_string(std::path::Path::new(cwd).join("untracked")).unwrap(), "u");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 5: a MERGE commit in <target>..HEAD → Err, history unchanged ----
    #[test]
    fn reword_past_rejects_merge_in_range_and_leaves_history_intact() {
        let dir = init_repo("rw_merge");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        let base = rev(cwd, "HEAD");
        let main = branch_of(cwd);

        run_git(cwd, &["checkout", "-q", "-b", "feature"]).unwrap();
        mk_commit(cwd, "f", "ff", "feature work", "F <f@x>");
        run_git(cwd, &["checkout", "-q", &main]).unwrap();
        mk_commit(cwd, "m", "mm", "main work", "M <m@x>");
        run_git(cwd, &["merge", "--no-ff", "--no-edit", "feature"]).unwrap();
        assert_eq!(
            run_git(cwd, &["rev-list", "--merges", "--count", &format!("{base}..HEAD")]).unwrap(),
            "1",
            "range contains a merge commit"
        );

        let head_before = rev(cwd, "HEAD");
        assert!(reword_past(cwd, &base, "rejected").is_err(), "merge in range → Err");
        assert_eq!(rev(cwd, "HEAD"), head_before, "history unchanged on rejection");
        assert_clean_attached(cwd, &main);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- codex guard: target NOT an ancestor of HEAD → Err ----
    #[test]
    fn reword_past_rejects_non_ancestor_target() {
        let dir = init_repo("rw_nonanc");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        let main = branch_of(cwd);
        // sibling branch commit that is NOT reachable from main.
        run_git(cwd, &["checkout", "-q", "-b", "side"]).unwrap();
        mk_commit(cwd, "s", "ss", "side only", "S <s@x>");
        let side_only = rev(cwd, "HEAD");
        run_git(cwd, &["checkout", "-q", &main]).unwrap();
        mk_commit(cwd, "m", "mm", "main head", "M <m@x>");

        let head_before = rev(cwd, "HEAD");
        assert!(reword_past(cwd, &side_only, "x").is_err(), "non-ancestor target → Err");
        assert_eq!(rev(cwd, "HEAD"), head_before, "history unchanged");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 7: empty / whitespace-only message → Err ----
    #[test]
    fn reword_past_rejects_empty_or_whitespace_message() {
        let dir = init_repo("rw_empty");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two head", "B <b@x>");
        let target = rev(cwd, "HEAD~1");
        let head_before = rev(cwd, "HEAD");

        assert!(reword_past(cwd, &target, "").is_err(), "empty message → Err");
        assert!(reword_past(cwd, &target, "   \t\n ").is_err(), "whitespace-only → Err");
        assert_eq!(rev(cwd, "HEAD"), head_before, "no rewrite happened");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 6: in-progress op (fake MERGE_HEAD) → Err, history intact ----
    #[test]
    fn reword_past_rejects_when_op_in_progress() {
        let dir = init_repo("rw_inprog");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two head", "B <b@x>");
        let target = rev(cwd, "HEAD~1");
        let head_before = rev(cwd, "HEAD");

        std::fs::write(
            std::path::Path::new(cwd).join(".git/MERGE_HEAD"),
            format!("{head_before}\n"),
        )
        .unwrap();
        assert!(op_in_progress(cwd), "precondition: op detected");

        assert!(reword_past(cwd, &target, "nope").is_err(), "in-progress op → Err");
        assert_eq!(rev(cwd, "HEAD"), head_before, "history unchanged");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 6: detached HEAD → Err (no branch to repoint) ----
    #[test]
    fn reword_past_rejects_detached_head() {
        let dir = init_repo("rw_detached");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two head", "B <b@x>");
        let target = rev(cwd, "HEAD~1");
        run_git(cwd, &["checkout", "-q", "--detach", "HEAD"]).unwrap();
        assert!(run_git(cwd, &["symbolic-ref", "--quiet", "HEAD"]).is_err(), "detached");

        assert!(reword_past(cwd, &target, "x").is_err(), "detached HEAD → Err");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 7 (injection): leading-dash hash rejected, never parsed as a flag ----
    #[test]
    fn reword_past_rejects_dash_hash_no_flag_injection() {
        let dir = init_repo("rw_dash");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two head", "B <b@x>");
        let head_before = rev(cwd, "HEAD");

        for bad in ["-rf", "--foo", "--all", "-D"] {
            assert!(reword_past(cwd, bad, "msg").is_err(), "{bad} rejected as option");
        }
        assert_eq!(rev(cwd, "HEAD"), head_before, "repo untouched");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- inv 7 (injection): shell metacharacters stored LITERALLY, no exec ----
    #[test]
    fn reword_past_message_metacharacters_are_literal_no_side_effects() {
        let dir = init_repo("rw_meta");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "one", "A <a@x>");
        mk_commit(cwd, "b", "2", "two", "B <b@x>");
        mk_commit(cwd, "c", "3", "three head", "C <c@x>");
        let target = rev(cwd, "HEAD~1");

        let evil = "$(touch pwned) `touch pwned2` ; rm -rf . && echo $HOME";
        reword_past(cwd, &target, evil).expect("metachar reword ok");

        assert_eq!(body(cwd, "HEAD~1"), evil, "message stored literally");
        assert!(!std::path::Path::new(cwd).join("pwned").exists(), "no $() execution");
        assert!(!std::path::Path::new(cwd).join("pwned2").exists(), "no backtick execution");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- Phase 4: backup_ref auto-prune keeps only the most recent BACKUP_KEEP ----
    #[test]
    fn backup_ref_prunes_to_most_recent_keep() {
        let dir = init_repo("bk_prune");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        let head = rev(cwd, "HEAD");
        // 25 fake backups with ascending nanos 1000..=1024 (all point at a valid commit).
        for n in 1000u128..1025 {
            run_git(cwd, &["update-ref", &format!("refs/backup/main-{n}-deadbee"), &head]).unwrap();
        }
        let before = run_git(cwd, &["for-each-ref", "--format=%(refname)", "refs/backup/"]).unwrap();
        assert_eq!(before.lines().count(), 25, "precondition: 25 backups");

        // A real backup uses current epoch nanos (≫ the fakes) → it is the newest and
        // its creation triggers the prune down to BACKUP_KEEP (20).
        let new_ref = backup_ref(cwd).unwrap();

        let after = run_git(cwd, &["for-each-ref", "--format=%(refname)", "refs/backup/"]).unwrap();
        let refs: Vec<&str> = after.lines().collect();
        assert_eq!(refs.len(), BACKUP_KEEP, "pruned to BACKUP_KEEP");
        assert!(refs.iter().any(|r| *r == new_ref), "newly created backup is retained");
        // 26 total − 20 kept = 6 oldest pruned (nanos 1000..=1005); 1006 survives.
        for n in 1000u128..1006 {
            assert!(!refs.iter().any(|r| r.contains(&format!("-{n}-"))), "oldest {n} pruned");
        }
        assert!(refs.iter().any(|r| r.contains("-1006-")), "1006 retained as newest-20");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backup_ref_nanos_parses_branch_with_dashes() {
        // branch "feat/git-control-reset" contains '-' and '/': nanos must still parse.
        assert_eq!(backup_ref_nanos("refs/backup/feat/git-control-reset-12345-abc123"), Some(12345));
        assert_eq!(backup_ref_nanos("refs/backup/main-9999-deadbee"), Some(9999));
        // Non-conforming (user-created) names → None → left untouched by prune.
        assert_eq!(backup_ref_nanos("refs/backup/garbage"), None);
        assert_eq!(backup_ref_nanos("refs/backup/no-nanos-here"), None);
    }

    // codex High: the just-created backup must survive even when OLDER refs carry
    // larger (future / clock-skewed) timestamps than the real current nanos.
    #[test]
    fn backup_ref_never_prunes_the_new_ref_even_with_future_timestamps() {
        let dir = init_repo("bk_protect");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        let head = rev(cwd, "HEAD");
        // 20 fakes with HUGE nanos (far in the future) → all "newer" than real epoch nanos.
        let huge = 100_000_000_000_000_000_000u128;
        for n in huge..huge + 20 {
            run_git(cwd, &["update-ref", &format!("refs/backup/main-{n}-deadbee"), &head]).unwrap();
        }
        let new_ref = backup_ref(cwd).unwrap();
        let after = run_git(cwd, &["for-each-ref", "--format=%(refname)", "refs/backup/"]).unwrap();
        let refs: Vec<&str> = after.lines().collect();
        assert_eq!(refs.len(), BACKUP_KEEP, "pruned to BACKUP_KEEP");
        assert!(refs.iter().any(|r| *r == new_ref), "new backup survives despite older future-dated refs");
        std::fs::remove_dir_all(&dir).ok();
    }

    // codex Medium: a user's own non-conforming refs/backup/* ref is NOT pruned.
    #[test]
    fn backup_ref_prune_leaves_foreign_refs_alone() {
        let dir = init_repo("bk_foreign");
        let cwd = dir.to_string_lossy().to_string();
        let cwd = cwd.as_str();
        mk_commit(cwd, "a", "1", "base", "A <a@x>");
        let head = rev(cwd, "HEAD");
        // A foreign ref under refs/backup/ that doesn't match our <nanos>-<short> format.
        run_git(cwd, &["update-ref", "refs/backup/user-keepme", &head]).unwrap();
        // Plenty of our-format refs so prune definitely runs.
        for n in 1000u128..1030 {
            run_git(cwd, &["update-ref", &format!("refs/backup/main-{n}-deadbee"), &head]).unwrap();
        }
        backup_ref(cwd).unwrap();
        let after = run_git(cwd, &["for-each-ref", "--format=%(refname)", "refs/backup/"]).unwrap();
        assert!(
            after.lines().any(|r| r == "refs/backup/user-keepme"),
            "non-conforming foreign ref must not be pruned"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
