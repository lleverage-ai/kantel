## Google Chrome for Testing

This sandbox image was built with `KANTEL_BROWSER=cft` (`apps/host/guest/Dockerfile`): in place of Debian's
Chromium it bundles Google Chrome for Testing, Google's zip from
https://googlechromelabs.github.io/chrome-for-testing/, in `/opt/chrome-for-testing` (with `/usr/bin/chromium`
pointing at it), at the version in `/etc/kantel/image.json` (`chromeForTesting`). Its `WidevineCdm` directory was
removed.

Chrome for Testing is a flavour of Google Chrome, under Google's terms (https://www.google.com/chrome/terms/), which
say: "You may not copy, modify, distribute, sell, or lease any part of our services or software". So this image may
not be redistributed. Kantel never publishes it (`apps/host/guest/release.sh --publish` refuses it); it is built only
for the hosts of whoever builds it. It is made from the Chromium open source project
(https://chromium.googlesource.com/chromium/src), whose third-party components' licences it lists at
`chrome://credits`. The libraries it uses are Ubuntu's packages (above).
