Results auto-deliver; NEVER busy-poll.{{#if waitTool}} Completely blocked? Call `wait` until it returns the first settled job you started{{#if ircEnabled}} or peer message{{/if}}.{{/if}}
{{#if ircEnabled}}Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast); peer messaging is never subagent completion.{{/if}}
`completed`: subagent yielded successfully; claimed artifacts unverified.
