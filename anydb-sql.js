var anyDB = require('any-db');


var sql = require('sql');
var url = require('url');
var _   = require('lodash');

var grouper = require('./grouper');

var EventEmitter = require('events').EventEmitter;

var queryMethods = ['select', 'from', 'insert', 'update',
    'delete', 'create', 'drop', 'alter', 'where',
    'indexes'];

function extractDialect(adr) {
    var dialect = url.parse(adr).protocol;
    dialect = dialect.substr(0, dialect.length - 1);
    if (dialect == 'sqlite3') 
        dialect = 'sqlite';
    return dialect;
}

module.exports = function (opt) {

    var pool, 
        db = {},
        dialect = extractDialect(opt.url);

    sql.setDialect(dialect);

    db.open = function() {
        if (pool) return; // already open        
        if (dialect == 'sqlite') {
            try {
                var sqlitepool = require('./sqlite-pool');
                pool = sqlitepool(opt.url, opt.connections);
            } catch (e) {
                throw new Error("Unable to load sqlite pool: " + e.message);
            }
        }
        else {
            pool = anyDB.createPool(opt.url, opt.connections);
        }
    }

    db.open();

    db.models = {};

    function extendedTable(table, opt) {
        // inherit everything from a regular table.
        var extTable = Object.create(table); 

        // make query methods return extended queries.
        queryMethods.forEach(function (key) {
            extTable[key] = function () {
                return extendedQuery(table[key].apply(table, arguments));
            }
        });


        // make as return extended tables.
        extTable.as = function () {
            return extendedTable(table.as.apply(table, arguments), opt);
        };
        extTable.eventEmitter = new EventEmitter();

        if (opt.has) defineProperties(extTable, opt.has);
        return extTable;
    }


    function defineProperties(owner, has) {
        Object.keys(has).forEach(function(name) {
            var what = has[name],
                table = what.from,
                many = what.many ? '[]' : '',
                foreign;
            Object.defineProperty(owner, name, { 
                get: function() {                                  
                    if (!foreign)
                        if (typeof(table) == 'string')
                            foreign = db.models[table];
                        else
                            foreign = table;
                    var ownerName = owner.alias || owner._name;
                    return foreign.as(ownerName + '.' + name + many);

                } 
            });
        });
    }




    function extendedQuery(query) {
        var extQuery = Object.create(query);
        var self = extQuery;

        self.__extQuery = true;

        extQuery.execWithin = function (where, fn) {
            var query = self.toQuery(); // {text, params}
            if (!fn)
                return where.query(query.text, query.values);
            else
                return where.query(query.text, query.values, function (err, res) {
                    if (err) {
                        err = new Error(err);
                        err.message = err.message.substr('Error  '.length) 
                        + ' in query `' + query.text 
                        + '` with params ' + JSON.stringify(query.values);
                    }
                    fn(err, res && res.rows ? res.rows.map(grouper.normalize) : null);
                });
        };

        extQuery.exec = extQuery.execWithin.bind(extQuery, pool);

        extQuery.all = extQuery.exec;

        extQuery.get = function (fn) {
            return self.exec(function (err, rows) {
                return fn(err, rows && rows.length ? rows[0] : null);
            })
        };

        /**
         * Returns a result from a query, mapping it to an object by a specified key.
         * @param {!String} keyColumn the column to use as a key for the map.
         * @param {!Function} callback called when the operation ends. Takes an error and the result.
         * @param {String|Array|Function=} mapper can be:<ul>
         *     <li>the name of the column to use as a value;</li>
         *     <li>an array of column names. The value will be an object with the property names from this array mapped to the
         *         column values from the array;</li>
         *     <li>a function that takes the row as an argument and returns a value.</li>
         *  </ul>
         *                                        If omitted, assumes all other columns are values. If there is only one
         *                                        other column, its value will be used for the object. Otherwise, the
         *                                        value will be an object with the values mapped to column names.
         * @param {Function=} filter takes a row and returns a value indicating whether the row should be inserted in the
         *                           result.
         */
        extQuery.allObject = function(keyColumn, callback, mapper, filter) {
            filter = filter || function() { return true; };

            if (mapper) {
                if (typeof mapper === 'string') {
                    var str = mapper;
                    mapper = function(row) { return row[str]; };
                } else if (typeof mapper === 'object') {
                    var arr = mapper;
                    mapper = function(row) {
                        var obj = {};
                        for (var j = 0; j < arr.length; j++) 
                            obj[arr[j]] = row[arr[j]];
                        return obj;
                    };
                }
            } else mapper = function(row) {
                var validKeys = Object.keys(row).filter(function(key) { 
                    return key != keyColumn; 
                });

                if (validKeys.length === 0) return null;
                else if (validKeys.length == 1) return row[validKeys[0]];
                else {
                    var obj = {};
                    for (var j = 0; j < validKeys.length; j++) 
                        obj[validKeys[j]] = row[validKeys[j]];
                    return obj;
                }
            };

            return self.exec(function(err, data) {
                if (err) return callback(err);

                var result = {};
                for (var i = 0; i < data.length; i++) {
                    if (filter(data[i])) {
                        result[data[i][keyColumn]] = mapper(data[i]);
                    }
                }

                callback(null, result);
            });
        };
        
        queryMethods.forEach(function (key) {
            extQuery[key] = function () {
                var q = query[key].apply(query, arguments);
                if (q.__extQuery) return q;
                return extendedQuery(q);
            }
        });

        extQuery.selectDeep = function() {
            return extQuery.select(db.allOf.apply(db, arguments));
        };



        return extQuery;
    }


    db.define = function (opt) {
        var t = extendedTable(sql.define.apply(sql, arguments), opt);
        db.models[opt.name] = t;
        return t;
    };


    db.close = function() {
        if (pool) 
            pool.close.apply(pool, arguments);
        pool = null;
    };

    db.begin = pool.begin.bind(pool);
    db.query = pool.query.bind(pool);


    function columnName(c) {
        var name = c.alias || c.name;
        if (c.primaryKey) 
            name = name + '##';
        return name;
    }

    db.allOf = function() {
        var tables = [].slice.call(arguments);
        return tables.reduce(function (all, table) {
            var tableName = table.alias || table._name;
            if (table.columns) 
                return all.concat(table.columns.map(function(c) {
                    return c.as(tableName + '.' + columnName(c));
                }));
            else if (table.aggregate) {
                var column = table;
                tableName = column.table.alias || column.table._name;
                return all.concat([column.as(tableName + '.' 
                                             + columnName(column))]);
            }
        }, []);
    };

    return db;

};

