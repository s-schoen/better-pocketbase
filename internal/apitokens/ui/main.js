if (!window.__betterPocketBaseApiTokensUI) {
    window.__betterPocketBaseApiTokensUI = true;

    const extensionBasePath = "/_/extensions/api-tokens";
    const routePath = "#/settings/api-tokens";

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

    function pageApiTokens() {
        app.store.title = "API tokens";

        const uniqueId = "api_tokens_" + app.utils.randomString();
        const requestKey = uniqueId + "_list";

        const data = store({
            page: 1,
            perPage: 30,
            totalItems: 0,
            totalPages: 0,
            items: [],
            owners: {},
            actors: {},
            selectedUser: null,
            usersCollection: null,
            setupChecked: false,
            isLoading: false,
            error: "",

            get hasUsersCollection() {
                return !!data.usersCollection?.id;
            },
            get canGoPrevious() {
                return !data.isLoading && data.page > 1;
            },
            get canGoNext() {
                return !data.isLoading && data.totalPages > 0 && data.page < data.totalPages;
            },
        });

        refreshUsersCollection();
        loadTokens(1);

        function findUsersCollection() {
            return app.store.collections.find((collection) => collection.name == "users" || collection.id == "users");
        }

        async function refreshUsersCollection() {
            let collection = findUsersCollection();
            if (!collection && app.store.loadCollections) {
                try {
                    await app.store.loadCollections();
                    collection = findUsersCollection();
                } catch (err) {
                    if (!err?.isAbort) {
                        console.warn("Failed to refresh collections before loading API token UI:", err);
                    }
                }
            }

            data.usersCollection = collection || null;
            data.setupChecked = true;
        }

        async function loadTokens(page = data.page) {
            data.isLoading = true;
            data.error = "";

            const query = {
                page: page,
                perPage: data.perPage,
            };

            if (data.selectedUser?.id) {
                query.userId = data.selectedUser.id;
            }

            try {
                const result = await app.pb.send("/api/api-tokens", {
                    method: "GET",
                    query: query,
                    requestKey: requestKey,
                });

                data.page = result.page || page;
                data.perPage = result.perPage || data.perPage;
                data.totalItems = result.totalItems || 0;
                data.totalPages = result.totalPages || 0;
                data.items = result.items || [];

                await resolveReferences(data.items);

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
                if (item.userId) {
                    ownerIds.add(item.userId);
                }

                collectActor(item.createdBy, actorIdsByCollection);
                collectActor(item.revokedBy, actorIdsByCollection);
            }

            const nextOwners = Object.assign({}, data.owners);
            const nextActors = Object.assign({}, data.actors);

            const userRecords = await fetchRecordsByIds("users", Array.from(ownerIds));
            for (const id in userRecords) {
                nextOwners[id] = displayRecord(userRecords[id]);
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

        function pickUser(selectedId, callback, btnText = "Select user") {
            if (!data.hasUsersCollection) {
                return;
            }

            app.modals.openRecordsPicker({
                collection: data.usersCollection,
                selectedIds: selectedId ? [selectedId] : [],
                maxSelect: 1,
                btnText: btnText,
                onselect: (records) => {
                    callback(records[0] || null);
                },
            });
        }

        function filterByUser(user) {
            data.selectedUser = user;
            data.page = 1;
            loadTokens(1);
        }

        function clearUserFilter() {
            data.selectedUser = null;
            data.page = 1;
            loadTokens(1);
        }

        function openCreateModal() {
            if (!data.hasUsersCollection) {
                return;
            }

            const modalId = "api_token_create_" + app.utils.randomString();
            const form = store({
                name: "",
                expiresAt: "",
                user: data.selectedUser,
                isSubmitting: false,
                error: "",
            });

            async function submit(e) {
                e.preventDefault();

                form.error = "";
                const name = form.name.trim();
                if (!form.user?.id) {
                    form.error = "Select the user that will own this API token.";
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
                        userId: form.user.id,
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
                        t.label({ htmlFor: modalId + "_user" }, "Owner"),
                        t.div(
                            { className: "api-token-user-picker" },
                            t.input({
                                id: modalId + "_user",
                                type: "text",
                                readOnly: true,
                                required: true,
                                value: () => form.user ? ownerText(form.user.id, form.user) : "",
                                placeholder: "Select a users record",
                                onclick: () => pickUser(form.user?.id, (user) => (form.user = user), "Use selected user"),
                            }),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn secondary",
                                    onclick: () => pickUser(form.user?.id, (user) => (form.user = user), "Use selected user"),
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

        function confirmRevoke(token) {
            const owner = ownerText(token.userId);
            app.modals.confirm(
                t.div(
                    { className: "txt-center" },
                    t.h6(null, "Revoke API token?"),
                    t.p(null, "This will permanently revoke ", t.strong(null, token.name), " for ", t.strong(null, owner), "."),
                ),
                async () => {
                    try {
                        await app.pb.send("/api/api-tokens/" + encodeURIComponent(token.id), {
                            method: "DELETE",
                            requestKey: null,
                        });
                        app.toasts.success("API token revoked.");
                        loadTokens(data.page);
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

        function openDetailsModal(token) {
            const modal = t.div(
                {
                    className: "modal popup api-token-details-modal",
                    onafterclose: (el) => el.remove(),
                },
                t.header(
                    { className: "modal-header" },
                    t.h5({ className: "m-auto" }, "API token details"),
                ),
                t.div(
                    { className: "modal-content" },
                    detailsTable(token),
                ),
                t.footer(
                    { className: "modal-footer" },
                    t.button(
                        {
                            type: "button",
                            className: "btn expanded",
                            onclick: () => app.modals.close(modal),
                        },
                        t.span({ className: "txt" }, "Close"),
                    ),
                ),
            );

            document.body.appendChild(modal);
            app.modals.open(modal);
        }

        function detailsTable(token) {
            const rows = [
                ["ID", token.id],
                ["Name", token.name],
                ["Owner", ownerText(token.userId)],
                ["Owner ID", token.userId],
                ["Access key", token.accessKey],
                ["Status", token.status],
                ["Created", dateText(token.created, "-")],
                ["Updated", dateText(token.updated, "-")],
                ["Expires", dateText(token.expiresAt, "Never")],
                ["Last used", dateText(token.lastUsedAt, "Never")],
                ["Revoked", dateText(token.revokedAt, "-")],
                ["Created by", actorText(token.createdBy)],
                ["Revoked by", actorText(token.revokedBy)],
            ];

            return t.table(
                { className: "api-token-details-table" },
                t.tbody(
                    null,
                    rows.map((row) => t.tr(
                        null,
                        t.th(null, row[0]),
                        t.td(null, row[1] || "-"),
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

        return t.div(
            {
                pbEvent: "pageApiTokens",
                className: "page page-api-tokens",
                onunmount: () => app.pb.cancelRequest(requestKey),
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
                            onclick: () => loadTokens(data.page),
                        }),
                        t.button(
                            {
                                type: "button",
                                className: "btn",
                                disabled: () => !data.hasUsersCollection,
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
                            hidden: () => !data.setupChecked || data.hasUsersCollection,
                        },
                        "Create a `users` auth collection before creating API tokens",
                    ),
                    t.div(
                        { className: "api-tokens-toolbar" },
                        t.div(
                            { className: "api-token-filter" },
                            t.span({ className: "txt-bold" }, "Owner filter"),
                            t.span(
                                { className: "api-token-filter-value" },
                                () => data.selectedUser ? ownerText(data.selectedUser.id, data.selectedUser) : "All users",
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn sm secondary",
                                    disabled: () => !data.hasUsersCollection,
                                    onclick: () => pickUser(data.selectedUser?.id, filterByUser, "Filter by selected user"),
                                },
                                t.span({ className: "txt" }, "Filter by user"),
                            ),
                            t.button(
                                {
                                    type: "button",
                                    className: "btn sm transparent secondary",
                                    hidden: () => !data.selectedUser,
                                    onclick: clearUserFilter,
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
                    pagination(),
                ),
                t.footer({ className: "page-footer" }, app.components.credits()),
            ),
        );

        function tokensTable() {
            return t.div(
                { className: "api-tokens-table-scroll" },
                t.table(
                    { className: "records-table responsive-table api-tokens-table" },
                    t.thead(
                        { className: "sticky" },
                        t.tr(
                            null,
                            t.th(null, "Name"),
                            t.th(null, "Owner"),
                            t.th(null, "Status"),
                            t.th(null, "Access key"),
                            t.th(null, "Created"),
                            t.th(null, "Expires"),
                            t.th(null, "Last used"),
                            t.th({ className: "col-actions" }, "Actions"),
                        ),
                    ),
                    t.tbody(
                        null,
                        () => {
                            if (data.isLoading) {
                                return t.tr(
                                    null,
                                    t.td({ colSpan: 8 }, t.span({ className: "skeleton-loader" })),
                                );
                            }

                            if (!data.items.length) {
                                return t.tr(
                                    null,
                                    t.td(
                                        { colSpan: 8, className: "txt-center txt-hint" },
                                        data.selectedUser ? "No API tokens found for the selected user." : "No API tokens found.",
                                    ),
                                );
                            }

                            return data.items.map((token) => t.tr(
                                { rid: token.id },
                                t.td({ "html-data-label": "Name" }, t.span({ className: "txt-bold" }, token.name)),
                                t.td({ "html-data-label": "Owner" }, ownerCell(token.userId)),
                                t.td({ "html-data-label": "Status" }, statusBadge(token.status)),
                                t.td(
                                    { "html-data-label": "Access key" },
                                    t.code({ className: "api-token-access-key" }, token.accessKey),
                                ),
                                t.td({ "html-data-label": "Created" }, dateElem(token.created, "-")),
                                t.td({ "html-data-label": "Expires" }, dateElem(token.expiresAt, "Never")),
                                t.td({ "html-data-label": "Last used" }, dateElem(token.lastUsedAt, "Never")),
                                t.td(
                                    { "html-data-label": "Actions", className: "api-token-actions" },
                                    t.button(
                                        {
                                            type: "button",
                                            className: "btn sm secondary",
                                            onclick: () => openDetailsModal(token),
                                        },
                                        t.span({ className: "txt" }, "Details"),
                                    ),
                                    t.button(
                                        {
                                            type: "button",
                                            className: "btn sm warning",
                                            hidden: () => token.status == "revoked",
                                            onclick: () => confirmRevoke(token),
                                        },
                                        t.span({ className: "txt" }, "Revoke"),
                                    ),
                                ),
                            ));
                        },
                    ),
                ),
            );
        }

        function pagination() {
            return t.div(
                { className: "api-tokens-pagination" },
                t.div(
                    { className: "txt-hint" },
                    () => {
                        if (data.totalItems == 0) {
                            return "0 tokens";
                        }
                        return "Page " + data.page + " of " + data.totalPages + " · " + data.totalItems + " tokens";
                    },
                ),
                t.div(
                    { className: "api-tokens-pagination-actions" },
                    t.button(
                        {
                            type: "button",
                            className: "btn sm secondary",
                            disabled: () => !data.canGoPrevious,
                            onclick: () => loadTokens(data.page - 1),
                        },
                        t.span({ className: "txt" }, "Previous"),
                    ),
                    t.button(
                        {
                            type: "button",
                            className: "btn sm secondary",
                            disabled: () => !data.canGoNext,
                            onclick: () => loadTokens(data.page + 1),
                        },
                        t.span({ className: "txt" }, "Next"),
                    ),
                ),
            );
        }

        function ownerCell(userId) {
            const owner = data.owners[userId];
            return t.div(
                { className: "api-token-owner" },
                t.span({ className: "api-token-owner-label" }, owner || userId || "-"),
                () => owner ? t.small({ className: "txt-hint" }, userId) : null,
            );
        }

        function statusBadge(status) {
            return t.span(
                { className: "api-token-status api-token-status-" + status },
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

        function ownerText(userId, record = null) {
            if (record) {
                return displayRecord(record) + " (" + record.id + ")";
            }

            const owner = data.owners[userId];
            return owner ? owner + " (" + userId + ")" : userId || "-";
        }

        function actorText(actor) {
            return data.actors[actor] || actor || "-";
        }
    }
}
