{{- define "arc-runners.image" -}}
{{- if .registry }}{{ .registry }}/{{ end }}{{ .repository }}:{{ .tag }}
{{- end -}}

{{- define "arc-runners.runnerImage" -}}
{{- $i := .Values.runnerImage -}}
{{- if $i.digest -}}
{{ $i.registry }}/{{ $i.repository }}@{{ $i.digest }}
{{- else -}}
{{ $i.registry }}/{{ $i.repository }}:{{ $i.tag }}
{{- end -}}
{{- end -}}

{{- /*
Organization slug from githubConfigUrl (last path segment) — mirrors
the upstream chart's actions.github.com/organization label.
*/ -}}
{{- define "arc-runners.org" -}}
{{- .Values.githubConfigUrl | trimSuffix "/" | splitList "/" | last -}}
{{- end -}}

{{- /*
NIX_CONFIG is immutable and content-addressed: changing one transfer
knob changes the runner pod template reference and lets Argo prune the
old ConfigMap after ARC has converged. The image's nix.conf owns the
substituters unless nixCache.url names a cache.
*/ -}}
{{- define "arc-runners.nixConfig" -}}
{{- $conf := .Values.nixConfig | default "" -}}
{{- /*
nixCache.url, when set, names a full substituter list (the
operator's cache first, upstream as the automatic fallback) -- the same
"name the FULL list, not `extra-`" rule image/runner/Dockerfile's own
nix.conf follows, for the same reason: the `extra-` form APPENDS to
Nix's default, so the list reads upstream-first and the operator's own
cache is never chosen. This overlay BEATS the image's baked nix.conf
(NIX_CONFIG wins), so a fleet whose cache moved never needs a rebuilt
image to say so. */ -}}
{{- if .Values.nixCache.url -}}
{{- if $conf }}{{ $conf = printf "%s\n" ($conf | trimSuffix "\n") }}{{ end -}}
{{- $conf = printf "%ssubstituters = %s https://cache.nixos.org/\n" $conf .Values.nixCache.url -}}
{{- end -}}
{{- $conf -}}
{{- end -}}

{{- /*
The release-wide ConfigMap name: a hash of the effective release-wide
payload above. Without nixCache.url that payload is `nixConfig` verbatim,
so the name is the same as the earlier chart's; with it, the name now
moves with the URL too (an immutable ConfigMap cannot be changed in
place, so a new URL under the old name was refused at apply time).
*/ -}}
{{- define "arc-runners.nixConfigName" -}}
runner-nix-config-{{ include "arc-runners.nixConfig" . | sha256sum | trunc 12 }}
{{- end -}}

{{- /*
A scale set's effective NIX_CONFIG payload — the release-wide
base (arc-runners.nixConfig) above, with THIS set's extraNixConfig
APPENDED (Nix reads its config top-to-bottom and keeps the LAST
occurrence of a scalar key, so appending is how a later key wins), and,
when nixSandbox.enabled, `sandbox = true` / `sandbox-fallback = false`
appended LAST of all — after extraNixConfig, not before — so nothing an
operator puts in extraNixConfig can quietly re-enable the unsandboxed
fallback on a set that asked to be sandboxed.

A scale set with neither key renders BYTE-IDENTICAL to the base
(arc-runners.nixConfig), so every such set shares the one release-wide
ConfigMap.

Takes a dict `{root, p}`: `root` is the chart's `.`, `p` the one scale
set's value block (`.Values.scaleSets.<name>`).
*/ -}}
{{- define "arc-runners.nixConfigFor" -}}
{{- $root := .root -}}
{{- $p := .p -}}
{{- $conf := include "arc-runners.nixConfig" $root -}}
{{- $extra := $p.extraNixConfig | default "" -}}
{{- if $extra -}}
{{- if $conf }}{{ $conf = printf "%s\n" ($conf | trimSuffix "\n") }}{{ end -}}
{{- $conf = printf "%s%s\n" $conf (trimSuffix "\n" $extra) -}}
{{- end -}}
{{- $sandbox := $p.nixSandbox | default (dict) -}}
{{- if $sandbox.enabled -}}
{{- if $conf }}{{ $conf = printf "%s\n" ($conf | trimSuffix "\n") }}{{ end -}}
{{- $conf = printf "%ssandbox = true\nsandbox-fallback = false\n" $conf -}}
{{- end -}}
{{- $conf -}}
{{- end -}}

{{- /*
The ConfigMap name for a scale set's effective payload above. A set
with neither extraNixConfig nor nixSandbox.enabled gets EXACTLY
arc-runners.nixConfigName — the same object every other unmodified set
already shares — so nix-config.yaml renders one ConfigMap for the whole
release, as before. A set that customises either gets its OWN
content-addressed name, so changing one set's extra config or turning
its sandbox on never touches another set's ConfigMap or recycles its
listener.
*/ -}}
{{- define "arc-runners.nixConfigNameFor" -}}
{{- $root := .root -}}
{{- $p := .p -}}
{{- $extra := $p.extraNixConfig | default "" -}}
{{- $sandbox := $p.nixSandbox | default (dict) -}}
{{- if or $extra $sandbox.enabled -}}
runner-nix-config-{{ include "arc-runners.nixConfigFor" (dict "root" $root "p" $p) | sha256sum | trunc 12 }}
{{- else -}}
{{- include "arc-runners.nixConfigName" $root -}}
{{- end -}}
{{- end -}}

{{- /*
Runner packing (see values.packing). The label is the chart's own (its
key is the one the chart had in truvity/ci-plane), not one the ARC
controller stamps: the controller's labels are internal to
its version, and a renamed one would turn packing back into spreading
without a single error. Every runner pod of every release of this chart
carries it, whatever the scale set and whatever the organization.
*/ -}}
{{- define "arc-runners.packingLabels" -}}
ci-plane.io/packing-group: runners
{{- end -}}

{{- /*
The runner pod's affinity: this scale set's own `affinity` if it set
one (REPLACING the release-wide value, same hasKey rule as the
other per-set overrides), else the release-wide `affinity`, with the
packing term APPENDED to podAffinity's preferred list, so either way a
caller's own node or pod affinity keeps working. Built on a deep copy:
this runs once per scale set, and appending to the values map itself
would give the second set two packing terms and the third set three.

namespaceSelector {} is load-bearing: without it a pod affinity term
matches pods in the pod's OWN namespace only, and each organization is
its own namespace, so two organizations' runners would never share a
node. Empty output means no affinity stanza at all.

Takes a dict `{root, p}`: `root` is the chart's `.`, `p` the one scale
set's value block.
*/ -}}
{{- define "arc-runners.affinity" -}}
{{- $root := .root -}}
{{- $p := .p -}}
{{- $base := $root.Values.affinity -}}
{{- if hasKey $p "affinity" }}{{ $base = $p.affinity }}{{ end -}}
{{- $aff := deepCopy ($base | default (dict)) -}}
{{- if $root.Values.packing.enabled -}}
{{- $weight := int $root.Values.packing.weight -}}
{{- if or (lt $weight 1) (gt $weight 100) }}{{ fail (printf "packing.weight must be between 1 and 100, got %v" $root.Values.packing.weight) }}{{ end -}}
{{- $podAffinity := get $aff "podAffinity" | default (dict) -}}
{{- $preferred := get $podAffinity "preferredDuringSchedulingIgnoredDuringExecution" | default (list) -}}
{{- $term := dict
      "weight" $weight
      "podAffinityTerm" (dict
        "topologyKey" "kubernetes.io/hostname"
        "namespaceSelector" (dict)
        "labelSelector" (dict "matchLabels" (include "arc-runners.packingLabels" $root | fromYaml))) -}}
{{- $_ := set $podAffinity "preferredDuringSchedulingIgnoredDuringExecution" (append $preferred $term) -}}
{{- $_ := set $aff "podAffinity" $podAffinity -}}
{{- end -}}
{{- if $aff }}{{ toYaml $aff }}{{ end -}}
{{- end -}}
