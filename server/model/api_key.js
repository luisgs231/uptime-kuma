const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
const dayjs = require("dayjs");

class APIKey extends BeanModel {
    /**
     * Get the current status of this API key
     * @returns {string} active, inactive or expired
     */
    getStatus() {
        let current = dayjs();
        let expiry = dayjs(this.expires);
        if (expiry.diff(current) < 0) {
            return "expired";
        }

        return this.active ? "active" : "inactive";
    }

    /**
     * Returns an object that ready to parse to JSON
     * @returns {object} Object ready to parse
     */
    toJSON() {
        return {
            id: this.id,
            key: this.key,
            name: this.name,
            userID: this.user_id,
            createdDate: this.created_date,
            active: this.active,
            expires: this.expires,
            status: this.getStatus(),
        };
    }

    /**
     * Returns an object that ready to parse to JSON with sensitive fields
     * removed
     * @returns {object} Object ready to parse
     */
    toPublicJSON() {
        return {
            id: this.id,
            name: this.name,
            userID: this.user_id,
            createdDate: this.created_date,
            active: this.active,
            expires: this.expires,
            status: this.getStatus(),
            // Only ever sent to the account that owns the key: the list is
            // fetched with user_id = the caller. Null for keys created before
            // the plaintext was kept, which cannot be recovered.
            plainKey: this.key_plain ?? null,
        };
    }

    /**
     * Create a new API Key and store it in the database
     * @param {object} key Object sent by client
     * @param {int} userID ID of socket user
     * @returns {Promise<bean>} API key
     */
    static async save(key, userID) {
        let bean;
        bean = R.dispense("api_key");

        bean.key = key.key;
        bean.name = key.name;
        bean.user_id = userID;
        bean.active = key.active;
        bean.expires = key.expires;

        await R.store(bean);

        return bean;
    }
}

module.exports = APIKey;
