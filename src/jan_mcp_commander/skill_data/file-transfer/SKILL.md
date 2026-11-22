---
name: file-transfer
description: "Guide a user through a direct file transfer between two online computers enrolled to the same PCRC account."
metadata:
  version: "1.1.0"
---

# File transfer

## Required PCRC tools

`get_connection_status`, `inspect_file`.

## Before transferring

1. Ask the user to open the PCRC Devices dashboard. Both computers must be registered to that same account, show Online at the same time, and have approved file access. Get their device IDs from **Device details & access**. Leave both PCRC launchers running.
2. Confirm both computers are on the same trusted router, by Wi-Fi or Ethernet. Ask the user for each computer's private IPv4 address from its network settings. The Wi-Fi name is useful for troubleshooting. PCRC verifies that the two specified computers can reach each other and that both hold valid enrollment keys for the same account.
3. Confirm the exact workspace-relative source and a new destination filename. Ask the user to review the contents before sharing.

## Transfer one file

The user runs these in interactive terminals. Use the listed tools to check connections and files where the assistant has access. The CLI independently verifies both enrolled devices. Keep the transfer code in the two terminals.

1. On the receiving PC, run `pcremotecommander cli --workspace <workspace> transfer receive --bind-ip <receiver-ip> --peer-ip <sender-ip> --peer-device <sender-device-id> --destination <relative-path>`. Review and approve the destination. The receiver displays a port and a one-time code and waits up to two minutes for the connection.
2. On the sending PC, run `pcremotecommander cli --workspace <workspace> transfer send --bind-ip <sender-ip> --peer-ip <receiver-ip> --peer-device <receiver-device-id> --port <shown-port> --source <relative-path>`. Approve the source and enter the code privately from the receiving PC. Keep it out of chat, logs and command arguments.
3. The receiver defaults to 120 MB, or 120,000,000 bytes. For a larger file add `--max-mb <approved-limit>` on the receiver, with space for the full uncompressed output. PCRC streams the file and compresses chunks only when doing so sends fewer bytes. Both launchers and the direct connection must stay up.

## Verify the result

Report the destination path, byte count and matching SHA-256 only after the transfer receipt. The original remains in place. Existing destination files are preserved. If the receipt is missing, inspect the destination before retrying.

If the direct connection fails, check both device addresses and whether the router allows devices to reach each other. Guest Wi-Fi commonly isolates devices. Stop if enrollment, access, or connectivity cannot be verified. Keep existing device access and network settings in place. Cloud upload and off-LAN delivery require a separate transfer feature.
