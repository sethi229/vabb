var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var S3Adapter = require('parse-server').S3Adapter;
var expressLayouts = require('express-ejs-layouts');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');
var cookieSession = require('cookie-session');

// Parse configuration
var databaseUri = process.env.DATABASE_URI || process.env.MONGOLAB_URI;
var serverUrl = process.env.SERVER_URL || 'http://localhost:1337/parse';
var appId = process.env.APP_ID || 'V6UKNW47paFwucxuKtlU';
var masterKey = process.env.MASTER_KEY || 'ABrx42jUFlh7jWhCUQdF';
var restApiKey = 'gpmcLCYftnTorbjilSuB';
var appName = 'nearme';

// Mailgun configuration
var apiKey = process.env.MAILGUN_API_KEY || 'key-081de803d2c09711d3a97648bb05fb92';
var domain = process.env.MAILGUN_DOMAIN || 'sandbox31f333fb60204e3eb551c7c17fcaa9cf.mailgun.org';
var fromAddress = process.env.MAILGUN_FROM_ADDRESS || 'QuanLabs <dev@quanlabs.com>';

// AWS S3 configuration
var accessKeyId = process.env.AWS_ACCESS_KEY_ID || 'AKIAIVLGLQJVUF3CZVQQ';
var secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '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';
var bucketName = process.env.BUCKET_NAME || 'marckos';

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var api = new ParseServer({
  databaseURI: databaseUri || 'mongodb://localhost:27017/dev',
  cloud: process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: appId,
  masterKey: masterKey,
  serverURL: serverUrl,
  restAPIKey: restApiKey,
  verifyUserEmails: false,
  publicServerURL: serverUrl,
  appName: appName,
  emailAdapter: {
    module: 'parse-server-simple-mailgun-adapter',
    options: {
      fromAddress: fromAddress,
      domain: domain,
      apiKey: apiKey,
    }
  },
  filesAdapter: new S3Adapter(
    accessKeyId,
    secretAccessKey,
    bucketName,
    { directAccess: true }
  ),
});

var app = express();

app.set('view engine', 'ejs');
app.set('views', 'views');

// Serve the Parse API on the /parse URL prefix
var mountPath = process.env.PARSE_MOUNT || '/parse';
app.use(mountPath, api);

app.use(express.static('public'));
app.use(expressLayouts);
app.use(cookieParser());
app.use(methodOverride());

app.use(cookieSession({
  name: 'nearme.sess',
  secret: 'SECRET_SIGNING_KEY',
  maxAge: 15724800000
}));

app.use(function (req, res, next) {
  res.locals.user = req.session.user;
  res.locals.page = req.url.split('/').pop();
  res.locals.appId = appId;
  res.locals.serverUrl = serverUrl;
  next();
});

var isNotInstalled = function (req, res, next) {

  var query = new Parse.Query(Parse.Role);
  query.equalTo('name', 'Admin');
  query.first().then(function (adminRole) {

    if (!adminRole) {
      return Parse.Promise.error(new Parse.Error(5000, 'Admin Role not found'));
    }

    var userRelation = adminRole.relation('users');
    return userRelation.query().count({ useMasterKey: true });
  }).then(function (count) {

    if (count === 0) {
      next();
    } else {
      req.session = null;
      res.redirect('/login');
    }
  }, function (error) {
    if (error.code === 5000) {
      next();
    } else {
      req.session = null;
      res.redirect('/login');
    }
  })
}

var isAdmin = function (req, res, next) {

  var objUser;

  return Parse.Cloud.httpRequest({
    url: serverUrl + '/users/me',
    headers: {
      'X-Parse-Application-Id': appId,
      'X-Parse-REST-API-Key': restApiKey,
      'X-Parse-Session-Token': req.session.token
    }
  }).then(function (userData) {

    objUser = Parse.Object.fromJSON(userData.data);

    var query = new Parse.Query(Parse.Role);
    query.equalTo('name', 'Admin');
    query.equalTo('users', objUser);
    return query.first();

  }).then(function (isAdmin) {

    if (!isAdmin) {
      return Parse.Promise.error();
    }

    req.user = objUser;
    return next();

  }).then(null, function () {
    req.session = null;
    res.redirect('/login');
  });
}

var isNotAuthenticated = function (req, res, next) {

  Parse.Cloud.httpRequest({
    url: serverUrl + '/users/me',
    headers: {
      'X-Parse-Application-Id': appId,
      'X-Parse-REST-API-Key': restApiKey,
      'X-Parse-Session-Token': req.session.token
    }
  }).then(function (userData) {
    res.redirect('/dashboard/places');
  }, function (error) {
    next();
  });
}

var urlencodedParser = bodyParser.urlencoded({ extended: false });

app.get('/install', isNotInstalled, function (req, res) {
  res.render('install');
});

app.post('/install', [urlencodedParser, isNotInstalled], function (req, res) {

  var name = req.body.name.trim();
  var username = req.body.username.toLowerCase().trim();
  var password = req.body.password.trim();
  var passwordConfirmation = req.body.passwordConfirmation.trim();

  if (!name) {
    return res.render('install', {
      flash: 'Name is required',
      input: req.body
    });
  }

  if (!username) {
    return res.render('install', {
      flash: 'Email is required',
      input: req.body
    });
  }

  if (password !== passwordConfirmation) {
    return res.render('install', {
      flash: "Password doesn't match",
      input: req.body
    });
  }

  if (password.length < 6) {
    return res.render('install', {
      flash: 'Password should be at least 6 characters',
      input: req.body
    });
  }

  var roles = [];

  var roleACL = new Parse.ACL();
  roleACL.setPublicReadAccess(true);

  var role = new Parse.Role('Admin', roleACL);
  roles.push(role);
  var role = new Parse.Role('User', roleACL);
  roles.push(role);

  var user = new Parse.User();
  user.set('name', name);
  user.set('username', username);
  user.set('email', username);
  user.set('password', password);
  user.set('roleName', 'Admin');
  user.set('photoThumb', undefined);

  var acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  user.setACL(acl);

  var query = new Parse.Query(Parse.Role);

  query.find().then(function (objRoles) {
    return Parse.Object.destroyAll(objRoles, { useMasterKey: true });
  }).then(function () {
    return Parse.Object.saveAll(roles);
  }).then(function () {
    return user.signUp();
  }).then(function (objUser) {

    req.session.user = objUser;
    req.session.token = objUser.getSessionToken();
    res.redirect('/dashboard/places');
  }, function (error) {
    res.render('install', {
      flash: error.message,
      input: req.body
    });
  });
});

app.get('/', function (req, res) {
  res.redirect('/install');
});

app.get('/login', isNotAuthenticated, function (req, res) {
  res.render('login');
});

app.get('/reset-password', isNotAuthenticated, function (req, res) {
  res.render('reset-password');
});

app.get('/dashboard/places', isAdmin, function (req, res) {
  res.render('places');
});

app.get('/dashboard/categories', isAdmin, function (req, res) {
  res.render('categories');
});

app.get('/dashboard/users', isAdmin, function (req, res) {
  res.render('users');
});

app.get('/dashboard/reviews', isAdmin, function (req, res) {
  res.render('reviews');
});

// Logs in the user
app.post('/login', [urlencodedParser, isNotAuthenticated], function (req, res) {

  var username = req.body.username;
  var password = req.body.password;

  Parse.User.logIn(username, password).then(function (user) {

    var query = new Parse.Query(Parse.Role);
    query.equalTo('name', 'Admin');
    query.equalTo('users', user);
    query.first().then(function (isAdmin) {

      if (!isAdmin) {
        res.render('login', {
          flash: 'Not Authorized'
        });
      } else {
        req.session.user = user;
        req.session.token = user.getSessionToken();
        res.redirect('/dashboard/places');
      }

    }, function (error) {
      res.render('login', {
        flash: error.message
      });
    });
  }, function (error) {
    res.render('login', {
      flash: error.message
    });
  });
});

app.get('/logout', isAdmin, function (req, res) {
  req.session = null;
  res.redirect('/login');
});

var port = process.env.PORT || 1337;
app.listen(port, function() {
    console.log('Parse server running on port ' + port + '.');
});
