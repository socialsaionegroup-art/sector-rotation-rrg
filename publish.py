"""
Refresh the prices and push the chart to GitHub Pages, so you can open it on
your phone from anywhere without this PC being switched on.

    python publish.py              # fetch fresh prices, then publish
    python publish.py --no-fetch   # publish whatever is already in data/
    python publish.py --no-push    # rebuild docs/ but don't commit (used by CI)
    python publish.py --setup      # print the one-time setup steps and exit

What it does: copies the four files the browser actually needs into docs/,
commits, and pushes. GitHub Pages serves docs/ on your repo's URL.

One-time setup is in --setup. After that this is the only command you run.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, "docs")
SITE_FILES = ["index.html", "app.js", "styles.css"]
DATA_REL = os.path.join("data", "prices.json")

SETUP = """
ONE-TIME SETUP  (about five minutes)

 1. Install Git for Windows if you haven't:   https://git-scm.com/download/win

 2. Make an empty repository on GitHub — say  sector-rotation-rrg.
    Public is fine; this only ever contains public market prices and the
    chart code. Do NOT tick "add a README".

 3. Tell Git who you are (once per machine — a commit needs an author):

        git config --global user.name  "Your Name"
        git config --global user.email "you@example.com"

 4. In this folder, build the site folder once so there is a docs/ to serve,
    then create the repo:

        python publish.py --no-push
        git init
        git add .
        git commit -m "Sector rotation RRG"
        git branch -M main
        git remote add origin https://github.com/YOURNAME/sector-rotation-rrg.git
        git push -u origin main

    In that remote line, replace YOURNAME with your actual GitHub username.
    Don't type angle brackets around it — cmd.exe reads < and > as file
    redirection and the command dies with "The system cannot find the file
    specified" before Git ever sees it.

 5. On GitHub: repository -> Settings -> Pages.
    Source = "Deploy from a branch",  Branch = main,  Folder = /docs.  Save.

 6. Wait a minute, then open:
        https://<your-username>.github.io/sector-rotation-rrg/


KEEPING IT UP TO DATE WITHOUT THIS PC

 7. The repo ships .github/workflows/refresh-prices.yml. Once the repo is on
    GitHub it refreshes the prices itself every weekday after the close and
    republishes — no PC needed.

    Check it is on:  repository -> Actions tab. If GitHub asks you to enable
    workflows, click the green button once.

 8. IMPORTANT — new repositories give Actions a read-only token, so the
    auto-publish would fail on its first run with "permission denied".
    Fix it once:  Settings -> Actions -> General -> Workflow permissions
    -> select "Read and write permissions" -> Save.

    To refresh on demand from your phone: Actions -> "Refresh prices"
    -> "Run workflow". The site updates a minute or so later.

From then on, if you ARE at the PC and want to push an update immediately:

        python publish.py

Bookmark that URL on your phone and add it to the home screen.
"""


def run(args, check=True):
    p = subprocess.run(args, cwd=HERE, capture_output=True, text=True, shell=False)
    if check and p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip())
    return p


def git(*args, check=True):
    return run(["git", *args], check=check)


def have_git():
    try:
        run(["git", "--version"])
        return True
    except Exception:  # noqa: BLE001
        return False


def main():
    if "--setup" in sys.argv:
        print(SETUP)
        return 0

    # ---- 1. fresh prices
    if "--no-fetch" not in sys.argv:
        sys.path.insert(0, HERE)
        import fetch_data
        print("Refreshing prices...\n")
        if fetch_data.main() != 0:
            print("\nFetch failed. Publishing would put stale data on the site, so stopping.")
            print("Use --no-fetch if you deliberately want to republish the existing data.")
            return 1
        print("")

    src_data = os.path.join(HERE, DATA_REL)
    if not os.path.exists(src_data):
        print("No data/prices.json — run  python fetch_data.py  first.")
        return 1

    # ---- 2. assemble docs/
    os.makedirs(os.path.join(DOCS, "data"), exist_ok=True)
    for f in SITE_FILES:
        shutil.copy2(os.path.join(HERE, f), os.path.join(DOCS, f))
    shutil.copy2(src_data, os.path.join(DOCS, DATA_REL))
    # stops GitHub Pages running the files through Jekyll, which ignores
    # folders it doesn't like and would silently drop data/
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    with open(src_data, "r", encoding="utf-8") as fh:
        meta = json.load(fh)["meta"]
    newest = max(m["last_date"] for m in meta)
    size = os.path.getsize(os.path.join(DOCS, DATA_REL)) / 1024.0
    print("Prepared docs/  — %d indices, prices to %s, %.0f KB" % (len(meta), newest, size))

    # ---- 3. push
    if "--no-push" in sys.argv:
        print("--no-push: docs/ rebuilt, leaving the commit to the caller.")
        return 0
    if not have_git():
        print("\nGit isn't installed or isn't on PATH, so I can't push.")
        print("Run  python publish.py --setup  for the steps.")
        return 1
    if not os.path.isdir(os.path.join(HERE, ".git")):
        print("\nThis folder isn't a Git repository yet.")
        print("Run  python publish.py --setup  for the one-time steps.")
        return 1

    git("add", "docs")
    staged = git("diff", "--cached", "--name-only").stdout.strip()
    if not staged:
        print("Nothing changed since the last publish — site is already current.")
        return 0

    msg = "Prices to %s (published %s)" % (newest, datetime.now().strftime("%Y-%m-%d %H:%M"))
    git("commit", "-m", msg)

    push = git("push", check=False)
    if push.returncode != 0:
        print("\nCommitted locally, but the push failed:\n" + (push.stderr or push.stdout).strip())
        print("\nFix the remote and run  git push  — the commit is already made.")
        return 1

    remote = git("remote", "get-url", "origin", check=False).stdout.strip()
    print("\nPublished: " + msg)
    if "github.com" in remote:
        slug = remote.split("github.com")[-1].lstrip(":/").removesuffix(".git")
        if "/" in slug:
            user, repo = slug.split("/", 1)
            print("Live in a minute or two at  https://%s.github.io/%s/" % (user, repo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
