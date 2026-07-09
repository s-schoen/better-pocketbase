if (!window.__betterPocketBaseApiTokensUI) {
    window.__betterPocketBaseApiTokensUI = true;

    const extensionBasePath = "/_/extensions/api-tokens";
    const routePath = "#/settings/api-tokens";
    const tokenQueryKey = "tokenId";

    document.head.appendChild(t.link({
        rel: "stylesheet",
        href: app.pb.buildURL(extensionBasePath + "/style.css"),
    }));

    registerSettingsLink();
    app.routes.superuserOnly(routePath, pageApiTokens);

    function registerSettingsLink() {
        if (!app.store.settingsNavGroups.Security) {
            const nextGroups = {};
            let inserted = false;

            for (const groupName in app.store.settingsNavGroups) {
                nextGroups[groupName] = app.store.settingsNavGroups[groupName];

                if (groupName == "System") {
                    nextGroups.Security = [];
                    inserted = true;
                }
            }

            if (!inserted) {
                nextGroups.Security = [];
            }

            app.store.settingsNavGroups = nextGroups;
        }

        const links = app.store.settingsNavGroups.Security;
        if (!links.find((link) => link.href == routePath)) {
            links.push({
                href: routePath,
                icon: "ri-key-2-line",
                label: "API tokens",
            });
        }
    }

    function pageApiTokens(route = {}) {
        app.store.title = "API tokens";

        const uniqueId = "api_tokens_" + app.utils.randomString();
        const requestKey = uniqueId + "_list";
        const collectionsRequestKey = uniqueId + "_collections";
        const queryTokenId = route.query?.[tokenQueryKey]?.[0] || "";

        const data = store({
            page: 1,
            perPage: 30,
            totalItems: 0,
            totalPages: 0,
            items: [],
            bulkSelected: {},
            owners: {},
            actors: {},
            selectedOwner: null,
            selectedOwnerCollection: null,
            activeTokenIdOrModel: queryTokenId,
            authCollections: [],
            setupChecked: false,
            isLoading: false,
            error: "",

            get hasAuthCollections() {
                return data.authCollections.length > 0;
            },
            get canLoadMore() {
                return data.totalPages > 0 && data.page < data.totalPages;
            },
            get totalSelected() {
                return Object.keys(data.bulkSelected).length;
            },
            get areAllSelected() {
                return data.items.length > 0 && data.items.every((token) => !!data.bulkSelected[token.id]);
            },
        });

        refreshAuthCollections().then(() => loadTokens(1));

        function findAuthCollections() {
            return app.store.collections
                .filter((collection) => collection.type == "auth" || collection.name == "_superusers")
                .sort((a, b) => collectionLabel(a).localeCompare(collectionLabel(b)));
        }

        async function refreshAuthCollections() {
            let collections = findAuthCollections();
            if (!collections.length) {
                try {
                    let loaded = await app.pb.collections.getFullList({
                        requestKey: collectionsRequestKey,
                    });
                    if (app.utils.sortedCollectionsByType) {
                        loaded = app.utils.sortedCollectionsByType(loaded);
                    }

                    app.store.collections = loaded;
                    collections = findAuthCollections();
                } catch (err) {
                    if (err?.isAbort) {
                        return;
                    }

                    console.warn("Failed to refresh collections before loading API token UI:", err);
                }
            }

            data.authCollections = collections;
            if (data.selectedOwnerCollection && !collections.find((collection) => collection.id == data.selectedOwnerCollection.id)) {
                data.selectedOwnerCollection = null;
            }
            if (!data.selectedOwnerCollection && collections.length) {
                data.selectedOwnerCollection = collections[0];
            }
            data.setupChecked = true;
        }

        async function loadTokens(page = data.page) {
            data.isLoading = true;
            data.error = "";

            const query = {
                page: page,
                perPage: data.perPage,
            };

            if (data.selectedOwner?.id) {
                query.authRecordId = data.selectedOwner.id;
            }

            try {
                const result = await app.pb.send("/api/api-tokens", {
                    method: "GET",
                    query: query,
                    requestKey: requestKey,
                });

                const items = result.items || [];

                await resolveReferences(items);

                data.page = result.page || page;
                data.perPage = result.perPage || data.perPage;
                data.totalItems = result.totalItems || 0;
                data.totalPages = result.totalPages || 0;

                if (data.page == 1) {
                    data.items = [];
                    data.bulkSelected = {};
                }

                for (const item of items) {
                    pushOrReplaceToken(item);
                }

                data.isLoading = false;
            } catch (err) {
                if (!err?.isAbort) {
                    data.isLoading = false;
                    data.error = err?.response?.message || err?.message || "Failed to load API tokens.";
                    app.checkApiError(err, false);
                }
            }
        }

        async function resolveReferences(items) {
            const ownerIds = new Set();
            const actorIdsByCollection = {};

            for (const item of items) {
                if (item.authRecordId) {
                    ownerIds.add(item.authRecordId);
                }

                collectActor(item.createdBy, actorIdsByCollection);
                collectActor(item.revokedBy, actorIdsByCollection);
            }

            const nextOwners = Object.assign({}, data.owners);
            const nextActors = Object.assign({}, data.actors);

            const unresolvedOwnerIds = new Set(ownerIds);
            for (const collection of data.authCollections) {
                if (!unresolvedOwnerIds.size) {
                    break;
                }

                const records = await fetchRecordsByIds(collection.name, Array.from(unresolvedOwnerIds));
                for (const id in records) {
                    nextOwners[id] = collectionLabel(collection) + ": " + displayRecord(records[id]);
                    unresolvedOwnerIds.delete(id);
                }
            }

            for (const collectionName in actorIdsByCollection) {
                const records = await fetchRecordsByIds(collectionName, Array.from(actorIdsByCollection[collectionName]));
                for (const id in records) {
                    const actor = collectionName + ":" + id;
                    nextActors[actor] = displayRecord(records[id]) + " (" + actor + ")";
                }
            }

            data.owners = nextOwners;
            data.actors = nextActors;
        }

        function collectActor(raw, idsByCollection) {
            if (!raw || !raw.includes(":")) {
                return;
            }

            const parts = raw.split(":");
            const collectionName = parts[0];
            const id = parts.slice(1).join(":");
            if (!collectionName || !id) {
                return;
            }

            idsByCollection[collectionName] = idsByCollection[collectionName] || new Set();
            idsByCollection[collectionName].add(id);
        }

        async function fetchRecordsByIds(collectionName, ids) {
            const result = {};
            if (!ids.length) {
                return result;
            }

            const filter = ids.map((id) => `id="${id.replaceAll("\"", "\\\"")}"`).join("||");

            try {
                const records = await app.pb.collection(collectionName).getFullList({
                    filter: filter,
                    requestKey: null,
                });

                for (const record of records) {
                    result[record.id] = record;
                }
            } catch (err) {
                if (!err?.isAbort) {
                    console.warn("Failed to resolve API token references for collection " + collectionName + ":", err);
                }
            }

            return result;
        }

        function collectionById(id) {
            return data.authCollections.find((collection) => collection.id == id) || null;
        }

        function authCollectionOptions() {
            return data.authCollections.map((collection) => ({
                value: collection.id,
                label: collectionLabel(collection),
            }));
        }

        function pickOwner(collection, selectedId, callback, btnText = "Select auth record") {
            if (!collection) {
                return;
            }

            const modalId = "api_token_owner_picker_" + app.utils.randomString();
            const picker = store({
                records: [],
                selected: null,
                isLoading: true,
                error: "",
            });

            function select(record) {
                picker.selected = record;
            }

            function submit() {
                if (!picker.selected) {
                    return;
                }
                callback(picker.selected, collection);
                app.modals.close(modal);
            }

            const modal = t.div(
                {
                    className: "modal popup api-token-owner-picker-modal",
                    onafterclose: (el) => el.remove(),
                    onunmount: () => app.pb.cancelRequest(modalId),
                },
                t.header(
                    { className: "modal-header" },
                    t.h5({ className: "m-auto" }, "Select " + collectionLabel(collection) + " owner"),
                ),
                t.div(
                    { className: "modal-content" },
                    t.div(
                        {
                            className: "alert danger",
                            hidden: () => !picker.error,
                        },
                        () => picker.error,
                    ),
                    () => picker.isLoading ? t.span({ className: "skeleton-loader" }) : null,
                    () => (!picker.isLoading && !picker.records.length && !picker.error)
                        ? t.p({ className: "txt-center txt-hint" }, "No auth records found.")
                        : null,
                    () => picker.records.map((record) => t.button(
                        {
                            type: "button",
                            className: () => "btn secondary expanded m-b-xs " + (picker.selected?.id == record.id ? "active" : ""),
                            onclick: () => select(record),
                        },
                        t.span({ className: "txt" }, ownerText(record.id, record, collection)),
                    )),
                ),
                t.footer(
                    { className: "modal-footer" },
                    t.button(
                        {
                            type: "button",
                            className: "btn transparent m-r-auto",
                            onclick: () => app.modals.close(modal),
                        },
                        t.span({ className: "txt" }, "Cancel"),
                    ),
                    t.button(
                        {
                            type: "button",
                            className: "btn",
                            disabled: () => !picker.selected,
                            onclick: submit,
                        },
                        t.span({ className: "txt" }, btnText),
                    ),
                ),
            );

            document.body.appendChild(modal);
            app.modals.open(modal);

            app.pb.collection(collection.name).getFullList({
                sort: "-created",
                requestKey: modalId,
            }).then((records) => {
                picker.records = records;
                picker.selected = records.find((record) => record.id == selectedId) || null;
                picker.isLoading = false;
            }).catch((err) => {
                if (!err?.isAbort) {
                    picker.error = err?.response?.message || err?.message || "Failed to load auth records.";
                    picker.isLoading = false;
                    app.checkApiError(err, false);
                }
            });
        }

        function filterByOwner(owner, collection) {
            data.selectedOwner = owner;
            data.selectedOwnerCollection = collection || data.selectedOwnerCollection;
            data.page = 1;
            loadTokens(1);
        }

        function clearOwnerFilter() {
            data.selectedOwner = null;
            data.page = 1;
            loadTokens(1);
        }

        function openCreateModal() {
            if (!data.hasAuthCollections) {
                return;
            }

            const modalId = "api_token_create_" + app.utils.randomString();
            const form = store({
                name: "",
                expiresAt: "",
                owner: data.selectedOwner,
                ownerCollection: data.selectedOwnerCollection || data.authCollections[0],
                isSubmitting: false,
                error: "",
            });

            async function submit(e) {
                e.preventDefault();

                form.error = "";
                const name = form.name.trim();
                if (!form.ownerCollection?.id) {
                    form.error = "Select the auth collection for this API token.";
                    return;
                }
                if (!form.owner?.id) {
                    form.error = "Select the auth record that will own this API token.";
                    return;
                }
                if (!name) {
                    form.error = "API token name is required.";
                    return;
                }

                form.isSubmitting = true;
                try {
                    const body = {
                        name: name,
                        authRecordId: form.owner.id,
                    };
                    if (form.expiresAt) {
                        body.expiresAt = app.utils.toRFC3339Datetime(form.expiresAt);
                    }

                    const result = await app.pb.send("/api/api-tokens", {
                        method: "POST",
                        body: body,
                        requestKey: modalId,
                    });

                    form.isSubmitting = false;
                    app.modals.close(modal);
                    setTimeout(() => openTokenRevealModal(result.token), 0);
                    loadTokens(1);
                } catch (err) {
                    if (!err?.isAbort) {
                        form.isSubmitting = false;
                        form.error = err?.response?.message || err?.message || "Failed to create API token.";
                        app.checkApiError(err, false);
                    }
                }
            }

            const modal = t.div(
                {
                    className: "modal popup api-token-create-modal",
                    onafterclose: (el) => el.remove(),
                    onunmount: () => app.pb.cancelRequest(modalId),
                },
                t.header(
                    { className: "modal-header" },
                    t.h5({ className: "m-auto" }, "Create API token"),
                ),
                t.form(
                    {
                        id: modalId,
                        className: "modal-content",
                        onsubmit: submit,
                    },
                    t.div(
                        { className: "field" },
                        t.label({ htmlFor: modalId + "_collection" }, "Owner collection"),
                        app.components.select({
                            id: modalId + "_collection",
                            required: true,
                            value: () => form.ownerCollection?.id || "",
                            options: () => authCollectionOptions(),
                            onchange: (selected) => {
                                form.ownerCollection = collectionById(selected?.[0]?.value || "");
                                form.owner = null;
                            },
                        }),
                    ),
                    t.div(
                        { className: "field" },
                        t.label({ htmlFor: modalId + "_owner" }, "Owner"),
                        t.div(
                            { className: "api-token-owner-picker" },
                            t.input({
                                id: modalId + "_owner",
                                type: "text",
                                readOnly: true,
                                required: true,
                                value: () => form.owner ? ownerText(form.owner.id, form.owner, form.ownerCollection) : "",
                                placeholder: "Select an auth record",
                                onclick: () => pickOwner(form.ownerCollection, form.owner?.id, (owner) => (form.owner = owner), "Use selected auth record"),
                            }),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn secondary",
                                    onclick: () => pickOwner(form.ownerCollection, form.owner?.id, (owner) => (form.owner = owner), "Use selected auth record"),
                                },
                                t.span({ className: "txt" }, "Select"),
                            ),
                        ),
                    ),
                    t.div(
                        { className: "field" },
                        t.label({ htmlFor: modalId + "_name" }, "Name"),
                        t.input({
                            id: modalId + "_name",
                            type: "text",
                            required: true,
                            maxLength: 200,
                            autofocus: true,
                            value: () => form.name,
                            oninput: (e) => (form.name = e.target.value),
                            placeholder: "CI deployment, CLI access, etc.",
                        }),
                    ),
                    t.div(
                        { className: "field" },
                        t.label({ htmlFor: modalId + "_expires" }, "Expires at"),
                        t.input({
                            id: modalId + "_expires",
                            type: "datetime-local",
                            value: () => form.expiresAt,
                            oninput: (e) => (form.expiresAt = e.target.value),
                        }),
                        t.p({ className: "help" }, "Leave blank for Never expires."),
                    ),
                    t.div(
                        {
                            className: "alert danger",
                            hidden: () => !form.error,
                        },
                        () => form.error,
                    ),
                ),
                t.footer(
                    { className: "modal-footer" },
                    t.button(
                        {
                            type: "button",
                            className: "btn transparent m-r-auto",
                            disabled: () => form.isSubmitting,
                            onclick: () => app.modals.close(modal),
                        },
                        t.span({ className: "txt" }, "Cancel"),
                    ),
                    t.button(
                        {
                            "html-form": modalId,
                            type: "submit",
                            className: () => "btn " + (form.isSubmitting ? "loading" : ""),
                            disabled: () => form.isSubmitting,
                        },
                        t.span({ className: "txt" }, "Create token"),
                    ),
                ),
            );

            document.body.appendChild(modal);
            app.modals.open(modal);
        }

        function openTokenRevealModal(token) {
            const modal = t.div(
                {
                    className: "modal popup manual api-token-reveal-modal",
                    onafterclose: (el) => el.remove(),
                },
                t.header(
                    { className: "modal-header" },
                    t.h5({ className: "m-auto" }, "Copy API token"),
                ),
                t.div(
                    { className: "modal-content" },
                    t.div(
                        { className: "alert warning" },
                        "This token is shown only once. Copy it now and store it somewhere safe.",
                    ),
                    t.div(
                        { className: "api-token-secret" },
                        t.code(null, token),
                        app.components.copyButton(token),
                    ),
                ),
                t.footer(
                    { className: "modal-footer" },
                    t.button(
                        {
                            type: "button",
                            className: "btn expanded",
                            onclick: () => app.modals.close(modal),
                        },
                        t.span({ className: "txt" }, "I copied the token"),
                    ),
                ),
            );

            document.body.appendChild(modal);
            app.modals.open(modal);
        }

        function pushOrReplaceToken(token) {
            const items = data.items.slice();
            const index = items.findIndex((item) => item.id == token.id);
            if (index >= 0) {
                items[index] = token;
            } else {
                items.push(token);
            }
            data.items = items;
        }

        function markTokenRevoked(token) {
            const updated = Object.assign({}, token, {
                status: "revoked",
                revokedAt: token.revokedAt || new Date().toISOString(),
            });

            if (data.items.some((item) => item.id == updated.id)) {
                pushOrReplaceToken(updated);
            }

            if (data.bulkSelected[updated.id]) {
                const bulkSelected = Object.assign({}, data.bulkSelected);
                bulkSelected[updated.id] = updated;
                data.bulkSelected = bulkSelected;
            }

            return updated;
        }

        async function revokeToken(token) {
            await app.pb.send("/api/api-tokens/" + encodeURIComponent(token.id), {
                method: "DELETE",
                requestKey: null,
            });

            return markTokenRevoked(token);
        }

        function selectedTokens() {
            return Object.values(data.bulkSelected);
        }

        function revokableSelectedTokens() {
            return selectedTokens().filter((token) => token.status != "revoked");
        }

        function selectAll(state = true) {
            const selected = {};
            if (state) {
                for (const token of data.items) {
                    selected[token.id] = token;
                }
            }
            data.bulkSelected = selected;
        }

        function downloadTokenJSON(token) {
            if (!token) {
                return;
            }

            app.utils.downloadJSON(token, tokenJSONFilename(token));
        }

        function copyTokenJSON(token) {
            if (!token) {
                return;
            }

            app.utils.copyToClipboard(JSON.stringify(token, null, 2));
            app.toasts.success("API token copied to clipboard!");
        }

        function tokenJSONFilename(token) {
            const date = (token.created || "").replaceAll(/[-:. T]/g, "");
            return "api_token_" + (date || token.id || "details") + ".json";
        }

        function downloadSelected() {
            const selected = selectedTokens().sort((a, b) => {
                if (a.created < b.created) {
                    return 1;
                }
                if (a.created > b.created) {
                    return -1;
                }
                return 0;
            });

            if (!selected.length) {
                return;
            }

            if (selected.length == 1) {
                return downloadTokenJSON(selected[0]);
            }

            return app.utils.downloadJSON(selected, selected.length + "_api_tokens.json");
        }

        function confirmRevokeSelected() {
            const selected = revokableSelectedTokens();
            if (!selected.length) {
                return;
            }

            app.modals.confirm(
                t.div(
                    { className: "txt-center" },
                    t.h6(null, "Revoke selected API tokens?"),
                    t.p(null, "This will permanently revoke ", t.strong(null, selected.length), " selected API token", selected.length == 1 ? "" : "s", "."),
                ),
                async () => {
                    try {
                        for (const token of selected) {
                            await revokeToken(token);
                        }
                        data.bulkSelected = {};
                        loadTokens(1);
                        app.toasts.success("Selected API tokens revoked.");
                    } catch (err) {
                        if (!err?.isAbort) {
                            app.checkApiError(err);
                            return false;
                        }
                    }
                },
                null,
                { yesButton: "Revoke", noButton: "Cancel" },
            );
        }

        function confirmRevoke(token, onDone) {
            if (!token || token.status == "revoked") {
                return;
            }

            const owner = ownerText(token.authRecordId);
            app.modals.confirm(
                t.div(
                    { className: "txt-center" },
                    t.h6(null, "Revoke API token?"),
                    t.p(null, "This will permanently revoke ", t.strong(null, token.name), " for ", t.strong(null, owner), "."),
                ),
                async () => {
                    try {
                        const updated = await revokeToken(token);
                        app.toasts.success("API token revoked.");
                        onDone?.(updated);
                        loadTokens(1);
                    } catch (err) {
                        if (!err?.isAbort) {
                            app.checkApiError(err);
                            return false;
                        }
                    }
                },
                null,
                { yesButton: "Revoke", noButton: "Cancel" },
            );
        }

        function getTokenId(tokenIdOrModel) {
            if (!tokenIdOrModel) {
                return null;
            }

            return typeof tokenIdOrModel === "string" ? tokenIdOrModel : tokenIdOrModel?.id;
        }

        function openTokenPreview(token) {
            data.activeTokenIdOrModel = token;
        }

        async function findTokenById(tokenId, requestKey) {
            const loaded = data.items.find((token) => token.id == tokenId);
            if (loaded) {
                return loaded;
            }

            let page = 1;
            let totalPages = 1;
            while (page <= totalPages) {
                const result = await app.pb.send("/api/api-tokens", {
                    method: "GET",
                    query: { page: page, perPage: 100 },
                    requestKey: requestKey,
                });

                const found = (result.items || []).find((token) => token.id == tokenId);
                if (found) {
                    return found;
                }

                totalPages = result.totalPages || 0;
                page++;
            }

            return null;
        }

        function openTokenPreviewModal(tokenIdOrModel, settings = {}) {
            let modal;
            const modalId = "api_token_preview_" + app.utils.randomString();
            const dropdownId = modalId + "_dropdown";
            const preview = store({
                isLoading: false,
                error: "",
                token: null,
            });

            async function load() {
                preview.isLoading = true;
                preview.error = "";

                try {
                    if (app.utils.isObject(tokenIdOrModel)) {
                        preview.token = JSON.parse(JSON.stringify(tokenIdOrModel));
                    } else {
                        preview.token = await findTokenById(tokenIdOrModel, modalId);
                    }

                    if (!preview.token) {
                        preview.error = "API token not found.";
                    } else {
                        await resolveReferences([preview.token]);
                    }

                    preview.isLoading = false;
                } catch (err) {
                    if (!err?.isAbort) {
                        preview.isLoading = false;
                        preview.error = err?.response?.message || err?.message || "Failed to load API token.";
                        app.checkApiError(err, false);
                    }
                }
            }

            modal = t.div(
                {
                    pbEvent: "apiTokenPreviewModal",
                    className: "modal api-token-preview-modal",
                    onbeforeopen: (el) => {
                        load();
                        return settings.onbeforeopen?.(el);
                    },
                    onafteropen: (el) => settings.onafteropen?.(el),
                    onbeforeclose: (el) => settings.onbeforeclose?.(el),
                    onafterclose: (el) => {
                        settings.onafterclose?.(el);
                        el?.remove();
                    },
                    onunmount: () => app.pb.cancelRequest(modalId),
                },
                t.header(
                    { className: "modal-header" },
                    t.h5(null, "API token details"),
                    t.button(
                        {
                            type: "button",
                            title: "More options",
                            className: () => "btn sm circle transparent m-l-auto " + (preview.isLoading ? "loading" : ""),
                            disabled: () => preview.isLoading || !preview.token,
                            "html-popovertarget": dropdownId,
                        },
                        t.i({ className: "ri-more-line", ariaHidden: true }),
                    ),
                    t.div(
                        { id: dropdownId, className: "dropdown", popover: "auto" },
                        (el) => {
                            if (!preview.token) {
                                return;
                            }

                            const actions = [
                                t.button(
                                    {
                                        type: "button",
                                        className: "dropdown-item",
                                        onclick: () => {
                                            copyTokenJSON(preview.token);
                                            el.hidePopover();
                                        },
                                    },
                                    t.i({ className: "ri-braces-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Copy JSON"),
                                ),
                                t.button(
                                    {
                                        type: "button",
                                        className: "dropdown-item",
                                        onclick: () => {
                                            downloadTokenJSON(preview.token);
                                            el.hidePopover();
                                        },
                                    },
                                    t.i({ className: "ri-download-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Download JSON"),
                                ),
                            ];

                            if (preview.token.status != "revoked") {
                                actions.push(t.button(
                                    {
                                        type: "button",
                                        className: "dropdown-item txt-danger",
                                        onclick: () => {
                                            el.hidePopover();
                                            confirmRevoke(preview.token, (updated) => {
                                                preview.token = updated;
                                            });
                                        },
                                    },
                                    t.i({ className: "ri-forbid-2-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Revoke"),
                                ));
                            }

                            return actions;
                        },
                    ),
                ),
                t.div(
                    { className: "modal-content" },
                    () => {
                        if (preview.isLoading) {
                            return t.div({ className: "block txt-center" }, t.span({ className: "loader" }));
                        }

                        if (preview.error) {
                            return t.div({ className: "alert danger" }, preview.error);
                        }

                        if (!preview.token) {
                            return t.div({ className: "txt-center txt-hint" }, "No API token selected.");
                        }

                        return tokenPreviewTable(preview.token);
                    },
                ),
                t.footer(
                    { className: "modal-footer" },
                    t.button(
                        {
                            type: "button",
                            className: "btn transparent m-r-auto",
                            onclick: () => app.modals.close(modal),
                        },
                        t.span({ className: "txt" }, "Close"),
                    ),
                ),
            );

            document.body.appendChild(modal);
            app.modals.open(modal);
        }

        function tokenPreviewTable(token) {
            const rows = [
                { name: "id", value: token.id, copy: token.id, className: "col-field-name-id" },
                { name: "name", value: token.name, copy: token.name, className: "col-field-type-text col-field-name-name" },
                { name: "owner", value: ownerText(token.authRecordId), copy: ownerText(token.authRecordId), className: "col-field-type-relation col-field-name-authRecordId" },
                { name: "authRecordId", value: token.authRecordId, copy: token.authRecordId, className: "col-field-type-relation col-field-name-authRecordId" },
                { name: "accessKey", value: t.code({ className: "api-token-access-key" }, token.accessKey), copy: token.accessKey, className: "col-field-type-text col-field-name-accessKey" },
                { name: "status", value: statusBadge(token.status), copy: token.status, className: "col-field-type-select col-field-name-status" },
                { name: "created", value: dateElem(token.created, "-"), copy: dateText(token.created, "-"), className: "col-field-type-date col-field-name-created" },
                { name: "updated", value: dateElem(token.updated, "-"), copy: dateText(token.updated, "-"), className: "col-field-type-date col-field-name-updated" },
                { name: "expiresAt", value: dateElem(token.expiresAt, "Never"), copy: dateText(token.expiresAt, "Never"), className: "col-field-type-date col-field-name-expiresAt" },
                { name: "lastUsedAt", value: dateElem(token.lastUsedAt, "Never"), copy: dateText(token.lastUsedAt, "Never"), className: "col-field-type-date col-field-name-lastUsedAt" },
                { name: "revokedAt", value: dateElem(token.revokedAt, "-"), copy: dateText(token.revokedAt, "-"), className: "col-field-type-date col-field-name-revokedAt" },
                { name: "createdBy", value: actorText(token.createdBy), copy: token.createdBy, className: "col-field-type-text col-field-name-createdBy" },
                { name: "revokedBy", value: actorText(token.revokedBy), copy: token.revokedBy, className: "col-field-type-text col-field-name-revokedBy" },
            ];

            return t.table(
                {
                    pbEvent: "apiTokenPreviewTable",
                    className: "api-token-preview-table responsive-table",
                },
                t.tbody(
                    null,
                    rows.map((row) => t.tr(
                        { rid: "api_token_preview_" + token.id + "_" + row.name },
                        t.th({ className: "min-width p-r-0 " + row.className }, row.name),
                        t.td({ className: row.className }, row.value || t.span({ className: "txt-hint" }, "-")),
                        t.td({ className: "col-copy min-width" }, app.components.copyButton(row.copy || "")),
                    )),
                ),
            );
        }

        function settingsSidebar() {
            return app.components.pageSidebar(
                { className: "settings-sidebar" },
                t.nav(
                    { className: "sidebar-content scrollable" },
                    () => {
                        const result = [];

                        for (const groupName in app.store.settingsNavGroups) {
                            const children = app.store.settingsNavGroups[groupName];

                            result.push(t.details(
                                { className: "nav-group", "html-data-group": groupName, open: true },
                                t.summary(
                                    { tabIndex: -1, onfocusout: () => false, onclick: () => false, onkeyup: () => false },
                                    groupName,
                                ),
                                () => children.map((link) => {
                                    const isLocal = link.href.startsWith("#/");

                                    return t.a(
                                        {
                                            href: () => link.href,
                                            target: () => !isLocal ? "_blank" : undefined,
                                            rel: () => !isLocal ? "noopener noreferrer" : undefined,
                                            className: (el) => {
                                                const isActive = link.isActive?.(el) || app.utils.isActivePath(link.href, false);
                                                return "nav-item " + (isActive ? "active" : "");
                                            },
                                        },
                                        () => link.icon ? t.i({ className: link.icon, ariaHidden: true }) : null,
                                        t.span({ className: "txt" }, () => link.label),
                                    );
                                }),
                            ));
                        }

                        return result;
                    },
                ),
            );
        }

        const watchers = [];

        return t.div(
            {
                pbEvent: "pageApiTokens",
                className: "page page-api-tokens",
                onmount: () => {
                    watchers.push(
                        watch(() => data.activeTokenIdOrModel, (newVal) => {
                            app.utils.replaceHashQueryParams({
                                [tokenQueryKey]: getTokenId(newVal),
                            });

                            if (!newVal) {
                                return;
                            }

                            app.modals.close(null, true);
                            openTokenPreviewModal(newVal, {
                                onafterclose: () => {
                                    data.activeTokenIdOrModel = null;
                                },
                            });
                        }),
                    );
                },
                onunmount: () => {
                    watchers.forEach((w) => w?.unwatch());
                    app.pb.cancelRequest(requestKey);
                    app.pb.cancelRequest(collectionsRequestKey);
                },
            },
            settingsSidebar(),
            t.div(
                { className: "page-content full-height" },
                t.header(
                    { className: "page-header" },
                    t.nav(
                        { className: "breadcrumbs" },
                        t.div({ className: "breadcrumb-item" }, "Settings"),
                        t.div({ className: "breadcrumb-item" }, () => app.store.title),
                    ),
                    t.div(
                        { className: "page-header-secondary-btns" },
                        app.components.refreshButton({
                            className: "btn circle transparent secondary tooltip-left",
                            onclick: () => refreshAuthCollections().then(() => loadTokens(1)),
                        }),
                        t.button(
                            {
                                type: "button",
                                className: "btn",
                                disabled: () => !data.hasAuthCollections,
                                onclick: openCreateModal,
                            },
                            t.i({ className: "ri-add-line", ariaHidden: true }),
                            t.span({ className: "txt" }, "Create token"),
                        ),
                    ),
                ),
                t.div(
                    { className: "wrapper api-tokens-wrapper m-b-base" },
                    t.div(
                        {
                            className: "alert warning",
                            hidden: () => !data.setupChecked || data.hasAuthCollections,
                        },
                        "Create an auth collection before creating API tokens",
                    ),
                    t.div(
                        { className: "api-tokens-toolbar" },
                        t.div(
                            { className: "api-token-filter" },
                            t.span({ className: "txt-bold" }, "Owner filter"),
                            app.components.select({
                                id: uniqueId + "_owner_filter_collection",
                                required: true,
                                disabled: () => !data.hasAuthCollections,
                                value: () => data.selectedOwnerCollection?.id || "",
                                options: () => authCollectionOptions(),
                                onchange: (selected) => {
                                    data.selectedOwnerCollection = collectionById(selected?.[0]?.value || "");
                                    data.selectedOwner = null;
                                    data.page = 1;
                                    loadTokens(1);
                                },
                            }),
                            t.span(
                                { className: "api-token-filter-value" },
                                () => data.selectedOwner ? ownerText(data.selectedOwner.id, data.selectedOwner, data.selectedOwnerCollection) : "All auth records",
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn sm secondary",
                                    disabled: () => !data.hasAuthCollections,
                                    onclick: () => pickOwner(data.selectedOwnerCollection, data.selectedOwner?.id, filterByOwner, "Filter by selected auth record"),
                                },
                                t.span({ className: "txt" }, "Filter by record"),
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn sm transparent secondary",
                                    hidden: () => !data.selectedOwner,
                                    onclick: clearOwnerFilter,
                                },
                                t.span({ className: "txt" }, "Clear"),
                            ),
                        ),
                    ),
                    t.div(
                        {
                            className: "alert danger",
                            hidden: () => !data.error,
                        },
                        () => data.error,
                    ),
                    tokensTable(),
                ),
                t.footer({ className: "page-footer" }, app.components.credits()),
            ),
        );

        function tokensTable() {
            return t.div(
                { className: "page-table-wrapper api-tokens-table-wrapper" },
                t.table(
                    { className: "records-table responsive-table api-tokens-table" },
                    t.thead(
                        { className: "sticky" },
                        t.tr(
                            null,
                            t.th(
                                { className: "col-bulk-select" },
                                t.div(
                                    {
                                        className: "field",
                                        hidden: () => data.isLoading,
                                    },
                                    t.input({
                                        id: uniqueId + "_select_all",
                                        type: "checkbox",
                                        disabled: () => !data.items.length,
                                        checked: () => data.areAllSelected,
                                        onchange: (e) => selectAll(e.target.checked),
                                    }),
                                    t.label({ htmlFor: uniqueId + "_select_all" }),
                                ),
                                t.span({
                                    className: "loader",
                                    hidden: () => !data.isLoading,
                                }),
                            ),
                            t.th(
                                { className: "col-field-type-text col-field-name-name" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-key-2-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Name"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-relation col-field-name-authRecordId" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-user-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Owner"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-select col-field-name-status" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-bookmark-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Status"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-text col-field-name-accessKey" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-fingerprint-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Access key"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-date col-field-name-created" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-calendar-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Created"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-date col-field-name-expiresAt" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-calendar-event-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Expires"),
                                ),
                            ),
                            t.th(
                                { className: "col-field-type-date col-field-name-lastUsedAt" },
                                t.div(
                                    { className: "inline-flex gap-5" },
                                    t.i({ className: "ri-history-line", ariaHidden: true }),
                                    t.span({ className: "txt" }, "Last used"),
                                ),
                            ),
                            t.th({ className: "col-meta" }),
                        ),
                    ),
                    t.tbody(
                        null,
                        () => {
                            if (!data.items.length && data.isLoading) {
                                return t.tr(
                                    null,
                                    t.td({ colSpan: 99 }, t.span({ className: "skeleton-loader" })),
                                );
                            }

                            if (!data.items.length) {
                                return t.tr(
                                    null,
                                    t.td(
                                        { colSpan: 99 },
                                        t.div(
                                            { className: "sticky-content txt-center txt-hint" },
                                            t.div({ className: "txt-bold" }, "No API tokens found."),
                                            data.selectedOwner ? "No API tokens found for the selected auth record." : "Create a token to get started.",
                                        ),
                                    ),
                                );
                            }

                            return data.items.map((token) => {
                                const tokenId = token.id;
                                const currentToken = () => data.items.find((item) => item.id == tokenId) || token;

                                return t.tr(
                                    {
                                        rid: tokenId,
                                        tabIndex: 0,
                                        role: "button",
                                        className: "handle",
                                        onclick: (e) => {
                                            e.preventDefault();
                                            openTokenPreview(currentToken());
                                        },
                                        onkeypress: (e) => {
                                            if (e.key == "Enter" || e.key == " ") {
                                                e.preventDefault();
                                                openTokenPreview(currentToken());
                                            }
                                        },
                                    },
                                    t.td(
                                        {
                                            className: "col-bulk-select",
                                            onclick: (e) => e.stopPropagation(),
                                            onkeypress: (e) => e.stopPropagation(),
                                        },
                                        t.div(
                                            { className: "field" },
                                            t.input({
                                                id: uniqueId + "_" + tokenId,
                                                type: "checkbox",
                                                checked: () => !!data.bulkSelected[tokenId],
                                                onchange: (e) => {
                                                    const bulkSelected = Object.assign({}, data.bulkSelected);
                                                    if (e.target.checked) {
                                                        bulkSelected[tokenId] = currentToken();
                                                    } else {
                                                        delete bulkSelected[tokenId];
                                                    }
                                                    data.bulkSelected = bulkSelected;
                                                },
                                            }),
                                            t.label({ htmlFor: uniqueId + "_" + tokenId }),
                                        ),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Name",
                                            className: "col-field-type-text col-field-name-name",
                                        },
                                        t.span({ className: "txt-bold" }, () => currentToken().name),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Owner",
                                            className: "col-field-type-relation col-field-name-authRecordId",
                                        },
                                        () => ownerCell(currentToken().authRecordId),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Status",
                                            className: "col-field-type-select col-field-name-status",
                                        },
                                        () => statusBadge(currentToken().status),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Access key",
                                            className: "col-field-type-text col-field-name-accessKey",
                                        },
                                        () => t.code({ className: "api-token-access-key" }, currentToken().accessKey),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Created",
                                            className: "col-field-type-date col-field-name-created",
                                        },
                                        () => dateElem(currentToken().created, "-"),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Expires",
                                            className: "col-field-type-date col-field-name-expiresAt",
                                        },
                                        () => dateElem(currentToken().expiresAt, "Never"),
                                    ),
                                    t.td(
                                        {
                                            "html-data-name": "Last used",
                                            className: "col-field-type-date col-field-name-lastUsedAt",
                                        },
                                        () => dateElem(currentToken().lastUsedAt, "Never"),
                                    ),
                                    t.td(
                                        { className: "col-meta" },
                                        t.i({ className: "ri-arrow-right-line", ariaHidden: true }),
                                    ),
                                );
                            });
                        },
                        t.tr(
                            { hidden: () => !data.canLoadMore },
                            t.td(
                                { colSpan: 99 },
                                t.button(
                                    {
                                        type: "button",
                                        className: () => "btn lg secondary load-more-btn " + (data.isLoading ? "transparent loading" : ""),
                                        disabled: () => data.isLoading,
                                        onclick: () => loadTokens(data.page + 1),
                                    },
                                    t.span({ className: "txt" }, "Load more"),
                                ),
                            ),
                        ),
                    ),
                ),
                t.div(
                    { className: "bulkbar-wrapper" },
                    t.div(
                        {
                            hidden: () => !data.totalSelected,
                            className: "bulkbar api-tokens-bulkbar",
                        },
                        t.span(
                            { className: "txt" },
                            "Selected ",
                            t.strong(null, () => data.totalSelected),
                            () => " " + (data.totalSelected == 1 ? "token" : "tokens"),
                        ),
                        t.button(
                            {
                                type: "button",
                                className: "btn sm secondary pill m-r-auto",
                                onclick: () => selectAll(false),
                            },
                            t.span({ className: "txt" }, "Reset"),
                        ),
                        t.button(
                            {
                                type: "button",
                                className: "btn sm pill outline danger",
                                disabled: () => !revokableSelectedTokens().length,
                                onclick: confirmRevokeSelected,
                            },
                            t.i({ className: "ri-forbid-2-line", ariaHidden: true }),
                            t.span({ className: "txt" }, "Revoke"),
                        ),
                        t.button(
                            {
                                type: "button",
                                className: "btn sm pill",
                                onclick: downloadSelected,
                            },
                            t.i({ className: "ri-download-line", ariaHidden: true }),
                            t.span({ className: "txt" }, "JSON"),
                        ),
                    ),
                ),
            );
        }

        function ownerCell(authRecordId) {
            const owner = data.owners[authRecordId];
            return t.div(
                { className: "api-token-owner" },
                t.span({ className: "api-token-owner-label" }, owner || authRecordId || "-"),
                () => owner ? t.small({ className: "txt-hint" }, authRecordId) : null,
            );
        }

        function statusBadge(status) {
            const labelClass = {
                active: "success",
                expired: "warning",
                revoked: "danger",
            }[status] || "";

            return t.span(
                { className: "label sm " + labelClass },
                status || "unknown",
            );
        }

        function dateElem(value, emptyText) {
            if (isEmptyDate(value)) {
                return t.span({ className: "txt-hint" }, emptyText);
            }

            return app.components.formattedDate({ value: value, short: true });
        }

        function dateText(value, emptyText) {
            if (isEmptyDate(value)) {
                return emptyText;
            }

            return app.utils.toLocalDatetime(value);
        }

        function isEmptyDate(value) {
            return !value || value.startsWith("0001-");
        }

        function displayRecord(record) {
            return record.email || record.username || record.name || record.id;
        }

        function collectionLabel(collection) {
            return collection?.name || collection?.id || "-";
        }

        function ownerText(authRecordId, record = null, collection = null) {
            if (record) {
                const prefix = collection ? collectionLabel(collection) + ": " : "";
                return prefix + displayRecord(record) + " (" + record.id + ")";
            }

            const owner = data.owners[authRecordId];
            return owner ? owner + " (" + authRecordId + ")" : authRecordId || "-";
        }

        function actorText(actor) {
            return data.actors[actor] || actor || "-";
        }
    }
}
