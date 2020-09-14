const WebSocket = require("ws");
const http = require("http");
const moment = require("moment");
const pino = require("pino");

// provide readable logging solution
const logger = pino(
  {
    prettyPrint:
      process.env.READABLE_LOGGING === "true" ? { translateTime: true } : false,
  },
  // log to file if path is specified, otherwise log to process.stdout
  pino.destination(process.env.LOG_FILE_PATH || 1)
);

logger.info("Process started");

// using the http server solely to
// prevent the node process from exiting by itself
const httpServer = http.createServer();
const wsServer = new WebSocket.Server({ server: httpServer });

// In memory "db" with users and chatEvents tables/collections.
// I initially intended to implement the observer pattern
// on these arrays and make the clients subscribe to their
// changes, but eventually went with a more simple approach
// so these arrays aren't ACTUALLY used anywhere, but I 
// decided to keep them just in case.
const users = [];
const chatEvents = [];

// these enums below would also be useful
// on the client, and on a real app I would
// try to find a solution (such as Lerna) which would allow them
// to be imported on both the server and the client,
// however for the purposes of this task, I will
// only be using strings on the client
const ClientMessageTypes = {
  JOIN_CHAT: "JOIN_CHAT",
  SUBMIT_CHAT_MESSAGE: "SUBMIT_CHAT_MESSAGE",
  LOGOUT: "LOGOUT",
};

const ServerMessageTypes = {
  JOIN_SUCCESS: "JOIN_SUCCESS",
  USER_JOINED: "USER_JOINED",
  USER_LOGOUT: "USER_LOGOUT",
  LOGOUT_SUCCESS: "LOGOUT_SUCCESS",
  LOGOUT_DUE_TO_INACTIVITY: "LOGOUT_DUE_TO_INACTIVITY",
  USER_LOGGED_OUT_DUE_TO_INACTIVITY: "USER_LOGGED_OUT_DUE_TO_INACTIVITY",
  CHAT_MSG_ADDED: "CHAT_MSG_ADDED",
  USER_CONNECTION_CLOSED: "USER_CONNECTION_CLOSED",
  ERROR: "ERROR",
};

const ErrorTypes = {
  USERNAME_EXISTS: "USERNAME_EXISTS",
  USERNAME_REQUIRED: "USERNAME_REQUIRED",
  INVALID_USERNAME: "INVALID_USERNAME",
  INVALID_MSG_TYPE: "INVALID_MSG_TYPE",
  INVALID_MSG_FORMAT: "INVALID_MSG_FORMAT",
  INVALID_CHAT_MSG: "INVALID_CHAT_MSG",
  AUTH_FAILED: "AUTH_FAILED",
};

const ChatEventTypes = {
  USER_JOINED: "USER_JOINED",
  MSG_ADDED: "MSG_ADDED",
  USER_LOGOUT: "USER_LOGOUT",
  USER_LOGGED_OUT_DUE_TO_INACTIVITY: "USER_LOGGED_OUT_DUE_TO_INACTIVITY",
  USER_CONNECTION_CLOSED: "USER_CONNECTION_CLOSED",
};

wsServer.on("connection", (ws) => {
  ws.on("close", (code, reason) => {
    if (ws.username) {
      const user = users.find((u) => u.username === ws.username);
      users.splice(users.indexOf(user), 1);
      ws.username = null;

      const disconnectEvt = {
        type: ChatEventTypes.USER_CONNECTION_CLOSED,
        occurredAt: new Date(),
        sourceUsername: user.username,
      };
      chatEvents.push(disconnectEvt);
      wsServer.clients.forEach((client) => {
        if (client.username) {
          client.send(
            JSON.stringify({
              type: ServerMessageTypes.USER_CONNECTION_CLOSED,
              payload: disconnectEvt,
            })
          );
        }
      });

      logger.info({
        msg: "Connection closed",
        code,
        reason,
        username: user.username,
      });
    }
  });

  ws.on("message", (message) => {
    logger.info({ receivedMsg: message });
    // TODO: try to break this
    // (I'm not 100% sure this validation is sufficiently secure)
    const { type, payload = {} } = (() => {
      try {
        return JSON.parse(message);
      } catch (err) {
        logger.warn("Invalid msg");
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.INVALID_MSG_FORMAT,
              message: "Invalid message format",
            },
          })
        );
      }
    })();


    if (type === ClientMessageTypes.JOIN_CHAT) {
      const { username } = payload;
      if (!username) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.USERNAME_REQUIRED,
              message: "Username is required",
            },
          })
        );
        return;
      }
      if (typeof username !== "string" || username.length >= 30) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.INVALID_USERNAME,
              message: "Invalid username",
            },
          })
        );
        return;
      }
      if (users.find((user) => user.username === username)) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.USERNAME_EXISTS,
              message: `Username "${username}" already exists`,
            },
          })
        );
        return;
      }

      const now = new Date();
      users.push({
        username,
        joinedAt: now,
        lastActivity: now,
      });

      const joinEvent = {
        type: ChatEventTypes.USER_JOINED,
        occurredAt: now,
        sourceUsername: username,
      };
      chatEvents.push(joinEvent);
      wsServer.clients.forEach((client) => {
        if (client.username) {
          client.send(
            JSON.stringify({
              type: ServerMessageTypes.USER_JOINED,
              payload: joinEvent,
            })
          );
        }
      });

      // since there is no mention of needing
      // persistent authentication, I'm going to use this
      // kinda hacky solution of just assigning the username
      // to the connection object
      ws.username = username;
      ws.send(
        JSON.stringify({
          type: ServerMessageTypes.JOIN_SUCCESS,
          payload: { user: { username } },
        })
      );
    } else if (type === ClientMessageTypes.SUBMIT_CHAT_MESSAGE) {
      if (
        !ws.username &&
        !users.find((user) => user.username === ws.username)
      ) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.AUTH_FAILED,
              message: "Authorization failed",
            },
          })
        );
        return;
      }

      const { message } = payload;
      if (
        !message ||
        typeof message !== "string" ||
        (message && message.length > 500)
      ) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.INVALID_CHAT_MSG,
              message: "Invalid chat message",
            },
          })
        );
        return;
      }

      const now = new Date();
      const chatMsg = {
        type: ChatEventTypes.MSG_ADDED,
        occurredAt: now,
        sourceUsername: ws.username,
        message,
      };
      chatEvents.push(chatMsg);

      // broadcast to all logged in clients
      // (including the sender)
      wsServer.clients.forEach((client) => {
        if (client.username) {
          client.send(
            JSON.stringify({
              type: ServerMessageTypes.CHAT_MSG_ADDED,
              payload: chatMsg,
            })
          );
        }
      });
      const user = users.find((user) => user.username === ws.username);
      user.lastActivity = now;
    } else if (type === ClientMessageTypes.LOGOUT) {
      if (!ws.username) {
        ws.send(
          JSON.stringify({
            type: ServerMessageTypes.ERROR,
            error: {
              type: ErrorTypes.AUTH_FAILED,
              message: "Authentication failed",
            },
          })
        );
        return;
      }
      const user = users.find((user) => user.username === ws.username);
      users.splice(users.indexOf(user), 1);
      ws.username = null;

      const logoutEvent = {
        type: ChatEventTypes.USER_LOGOUT,
        occurredAt: new Date(),
        sourceUsername: user.username,
      };
      chatEvents.push(logoutEvent);
      wsServer.clients.forEach((client) => {
        if (client.username) {
          client.send(
            JSON.stringify({
              type: ServerMessageTypes.USER_LOGOUT,
              payload: logoutEvent,
            })
          );
        }
      });
      ws.send(
        JSON.stringify({
          type: ServerMessageTypes.LOGOUT_SUCCESS,
        })
      );
    } else {
      logger.warn('Invalid msg type');
      ws.send(
        JSON.stringify({
          type: ServerMessageTypes.ERROR,
          error: {
            type: ErrorTypes.INVALID_MSG_TYPE,
            message: "Invalid message type",
          },
        })
      );
    }
  });
});

// Disconnect users due to inactivity.
// In a real app I might create a cron job
// but for this, setInterval will be good enough.
const disconnectTaskId = setInterval(() => {
  // Client inactivity is configurable through
  // environment variables.
  // Inactivity margin is measured in milliseconds
  const { INACTIVITY_MARGIN = 3000000 } = process.env;
  const inactivityThreshold = moment().subtract(INACTIVITY_MARGIN).toDate();
  const inactiveUsers = users.filter(
    (user) => user.lastActivity <= inactivityThreshold
  );

  wsServer.clients.forEach((client) => {
    if (
      client.username &&
      inactiveUsers.find((u) => u.username === client.username)
    ) {
      client.username = null;
      client.send(
        JSON.stringify({
          type: ServerMessageTypes.LOGOUT_DUE_TO_INACTIVITY,
        })
      );
    }
  });

  inactiveUsers.forEach((user) => {
    // remove user from "db"
    users.splice(users.indexOf(user), 1);

    const disconnectEvt = {
      type: ChatEventTypes.USER_LOGGED_OUT_DUE_TO_INACTIVITY,
      occurredAt: new Date(),
      targetUsername: user.username,
    };
    chatEvents.push(disconnectEvt);

    // notify remaining logged in clients
    // about this user's disconnect
    wsServer.clients.forEach((client) => {
      if (client.username) {
        client.send(
          JSON.stringify({
            type: ServerMessageTypes.USER_LOGGED_OUT_DUE_TO_INACTIVITY,
            payload: disconnectEvt,
          })
        );
      }
    });
  });
}, 1000);

wsServer.on("error", (err) => {
  logger.error(err);
});

const port = process.env.PORT || 8080;
wsServer.on("listening", () => {
  logger.info(`Server listening on port ${port}`);
});
httpServer.listen(port);

// Terminate gracefully upon receiving SIGINT or SIGTERM signals
const handleProcessExit = async (signal) => {
  logger.info(signal);
  clearInterval(disconnectTaskId);

  const wsSrvClosePromise = new Promise((resolve) => wsServer.close(resolve));
  const httpSrvClosePromise = new Promise((resolve) =>
    httpServer.close(resolve)
  );

  await Promise.all([httpSrvClosePromise, wsSrvClosePromise]);

  process.exit();
};
process.on("SIGINT", handleProcessExit);
process.on("SIGTERM", handleProcessExit);
