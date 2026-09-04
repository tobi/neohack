# CI-only host policy for Ubuntu's restricted unprivileged user namespaces.
# Permit the trusted sandbox constructor to create namespaces; the child still
# runs with dropped capabilities, read-only source mounts and an isolated net.
# This is not installed by the application and does not disable AppArmor globally.
abi <abi/4.0>,
include <tunables/global>

profile neonethack-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
