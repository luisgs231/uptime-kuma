const { sync: rimrafSync } = require("rimraf");
const Database = require("../server/database");

class TestDB {
    dataDir;

    constructor(dir = "./data/test") {
        this.dataDir = dir;
    }

    async create() {
        // destroy() clears the directory, but a run that is killed or crashes
        // never reaches it. Whatever it left behind would be adopted here as a
        // working database, so the next run inherits its rows - which surfaces
        // much later as "that username is already taken" in an unrelated hook.
        this.dataDir && rimrafSync(this.dataDir);

        Database.initDataDir({ "data-dir": this.dataDir });
        Database.dbConfig = {
            type: "sqlite",
        };
        Database.writeDBConfig(Database.dbConfig);
        await Database.connect(true);
        await Database.patch();
    }

    async destroy() {
        await Database.close();
        this.dataDir && rimrafSync(this.dataDir);
    }
}

module.exports = TestDB;
