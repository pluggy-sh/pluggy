# Documentation

This convention defines how to write documentation that stays accurate, scannable, and consistent. It applies to every prose surface in the project: READMEs, guides, reference pages, command help text, and PR descriptions. Examples are shown as Bad and Good pairs.

Lead with the answer. The first sentence of every section tells the reader what they will learn or what the section does. Do not bury the point under context, history, or hedging.
Bad: "There are several ways to configure pluggy, depending on what you are doing."
Good: "Configure pluggy by editing `project.json`. Every key is documented below."

Address the reader as "you" and write in active voice and present tense. Active voice names the actor and stays short. Present tense describes how the system behaves, not how it once behaved.
Bad: "The server will be queried by the client when a request has been made."
Good: "The client queries the server on each request."

Use "must" for requirements and "we recommend" for recommendations. Avoid "should" because it hides whether the rule is mandatory.
Bad: "You should run `vp check` before committing."
Good: "Run `vp check` before committing." or "We recommend running `vp check` before committing."

Prefer simple words and precise verbs. Cut hedges, jargon, anthropomorphism, and marketing language. "Lets you" beats "allows you to." "The server returns" beats "the server thinks."
Bad: "This powerful feature allows users to leverage advanced caching capabilities."
Good: "Caching speeds up repeated builds. Enable it with `cache: true`."

Show the artifact when introducing a tool or feature. Developers engage with code, file trees, configuration, and CLI sessions, not with adjective-led benefit lists. A real terminal session, a directory layout, or the actual config file sells better than prose that describes how the tool feels, and stays accurate as the code evolves.
Bad: "pluggy gives you a clean, intuitive workflow with a beautifully simple project file."
Good: a `project.json` snippet, the resulting directory tree, and three terminal commands that produce them.

Use meaningful names in examples. Placeholders like `foo` and `bar` strip the example of the context that helps a reader map it to their own problem.
Bad: `function foo(bar) { return bar.baz; }`
Good: `function balance(account) { return account.deposits; }`

Spell out Latin abbreviations. "For example" and "that is" read more naturally than "e.g." and "i.e." and translate cleanly for non-native speakers.
Bad: "Pass any flag (e.g., `--json`) to the command."
Good: "Pass any flag, for example `--json`, to the command."

Rarely use em-dashes. They fragment sentences and read as a tic when overused. Reach first for a period when the thought is complete, a comma when the aside is short, parentheses when it is genuinely parenthetical, or a colon when the second clause explains the first. Reserve em-dashes for the rare interruption that none of those carry.
Bad: "Run `vp check` — it formats, lints, and type-checks — before committing."
Good: "Run `vp check` before committing. It formats, lints, and type-checks."

Use sentence case for headings, and place one introductory paragraph between every heading and its first list. A heading followed immediately by bullets leaves the reader without context for what the list represents.
Bad: `## Configuration\n- cache: enable build cache\n- ...`
Good: `## Configuration\n\nConfigure pluggy through \`project.json\`. Every key below is optional.\n\n- cache: enable build cache`

Use numbered lists for sequential steps and bulleted lists for everything else. Keep items parallel: every item begins with the same part of speech, such as an imperative verb for steps or a noun for inventory.
Bad: bullet list mixing "Install dependencies" and "Caching is enabled by default"
Good: bullet list with "Install dependencies" and "Enable caching"

State conditions before actions. The reader needs to know where they are before being told what to do, otherwise they act in the wrong place and back out.
Bad: "Click `Save` on the Settings page."
Good: "On the Settings page, click `Save`."

Format identifiers consistently. Use code font for filenames, commands, code, environment variables, and API names. Use bold for UI elements such as button labels and menu names. Use plain text for prose.
Bad: "Run **vp check** in the _src/_ directory."
Good: "Run `vp check` in the `src/` directory."

Write descriptive link text that makes sense out of context. Screen readers and link lists strip the surrounding prose; "click here" tells the user nothing.
Bad: "For install instructions, [click here](README.md)."
Good: "See the [install instructions](README.md)."

Keep docs accurate to the implementation. Documentation that contradicts the code is worse than no documentation. Update docs in the same change as the behaviour they describe, and when you rename a heading, update every link that targets it.
Bad: a `--cache` flag described in the README that was removed two releases ago.
Good: removing the flag and its README entry in the same commit.

Do not duplicate facts. Each fact lives in one place; other pages link to it. Duplicated facts drift, and readers chasing the second copy will read the stale one.
Bad: install steps copy-pasted into both `README.md` and `docs/getting-started.md`.
Good: `README.md` links to `docs/getting-started.md` for install steps.

Close with what's next when applicable. End how-to and tutorial pages with a short "Next steps" section linking to the natural follow-up. Reference pages need no closer.
Bad: a tutorial that ends with "That's it!"
Good: a tutorial that ends with "Next steps" linking to the deployment guide.

These rules together produce documentation that stays useful as the project evolves. When a doc feels hard to read, the answer is almost always one of: buried point, passive voice, hidden requirement, vague verb, abstract instead of demonstrated, placeholder-shaped example, Latin abbreviation, em-dash clutter, missing context paragraph, mismatched list, conditions after actions, inconsistent formatting, undescriptive link, stale fact, duplicated fact, or missing follow-up. Check in that order.
