# Start Orislop on Vast from Windows

This is the shortest safe path from the v4 ZIP to extension testing. It keeps
the detector private and does not put a Hugging Face token in a command, file,
ZIP, or log.

## Before the one command

1. Rent the Vast instance using the settings in `VAST_PRODUCTION_DEPLOY.md`.
2. Add a **new** least-privilege Hugging Face read token as the private Vast
   environment variable `HF_TOKEN`.
3. Have the SSH private key registered with Vast on this Windows computer.
4. Copy the instance's current dynamic IP and the public port mapped to
   `22/tcp`. The SSH port is not the Machine Copy Port.

## The one command

Run this from any PowerShell directory, replacing only the three placeholders:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Users\aarush\Downloads\orislop_extension_test_ready_v4_production\START_ORISLOP_VAST.ps1" -DynamicIP "YOUR_VAST_DYNAMIC_IP" -SshPort YOUR_22_TCP_MAPPED_PORT -IdentityFile "C:\PATH\TO\YOUR\VAST_PRIVATE_KEY"
```

The command validates the local package, uploads it, safely installs or resumes
the same source release on `/workspace`, starts the detached GPU service, waits
for real `/ready`, and opens the private tunnel:

```text
http://127.0.0.1:4317 -> SSH -> Vast 127.0.0.1:4317
```

Leave that PowerShell window open. In Chrome, visit `chrome://extensions`, turn
on Developer mode, choose **Load unpacked**, and select:

```text
D:\Users\aarush\Downloads\orislop_extension_test_ready_v4_production\apps\extension\dist
```

After a Vast restart, run the exact same Windows command. Verified downloads
and installed dependencies are reused, stale process receipts are recovered,
and a live service is not duplicated.

For a no-network validation of paths and arguments, append `-DryRun`.
