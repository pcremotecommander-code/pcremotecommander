# Device pairing

Run the current PCRC installer or `npx --yes pcremotecommander@beta setup` in the account that will operate the computer. Compare the terminal verification code with the website, review permissions and approve only a pairing you started. Keep the terminal open while connected.

Use the same PCRC account when connecting an assistant. The device agent and the assistant's OAuth grant are separate: an online terminal does not repair an expired/revoked assistant grant. A successful public diagnostic can verify that a request reached the selected device.

Later launches reuse a verified installation and saved valid pairing. Temporary network loss may reconnect; invalid/revoked identity or changed-account access must not be silently restored. Never delete local credential folders as routine troubleshooting. Use device revocation and the supported approval/recovery flow.

Pairing codes, links, session credentials and assignment tokens are private. Do not put them in issues, shell histories, source commits or screenshots intended for publication.
