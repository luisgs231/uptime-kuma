<template>
    <div class="d-flex justify-content-center align-items-center">
        <div class="logo d-flex flex-column justify-content-center align-items-center">
            <object class="my-4" width="200" height="200" :data="$root.iconUrl || '/icon.svg'" />
            <div class="fs-4 fw-bold">Uptime Kuma</div>
            <div>Based on Uptime Kuma {{ $t("versionIs", { version: $root.info.version }) }}</div>
            <div class="frontend-version">{{ $t("frontendVersionIs", { version: $root.frontendVersion }) }}</div>

            <div v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning mt-4" role="alert">
                ⚠️ {{ $t("Frontend Version do not match backend version!") }}
            </div>

            <div class="my-3 update-link">
                <a href="https://github.com/luisgs231/uptime-kuma" target="_blank" rel="noopener">
                    {{ $t("Check Update On GitHub") }}
                </a>
            </div>

            <div class="mt-5">
                <p>
                    {{ $t("Font Twemoji by Twitter licensed under") }}
                    <a href="https://creativecommons.org/licenses/by/4.0/">CC-BY 4.0</a>
                </p>
            </div>
        </div>
    </div>
</template>

<script>
export default {};
</script>

<style lang="scss" scoped>
.logo {
    margin: 4em 1em;
}

.update-link {
    font-size: 0.8em;
}

.frontend-version {
    font-size: 0.9em;
    color: #cccccc;

    .dark & {
        color: #333333;
    }
}
</style>
