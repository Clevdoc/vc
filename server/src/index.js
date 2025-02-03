let http = require("http");
let express = require("express");
let cors = require("cors");
let socketio = require("socket.io");
let wrtc = require("wrtc");

const app = express();
const server = http.createServer(app);

app.use(cors());

let receiverPCs = {};
let senderPCs = {};
let users = {}; // roomID -> [{ id, stream, username }]
let socketToRoom = {}; // socketID -> { roomID, username }

const pc_config = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

const isIncluded = (array, id) => array.some((item) => item.id === id);

const createReceiverPeerConnection = (socketID, socket, roomID, username) => {
  const pc = new wrtc.RTCPeerConnection(pc_config);

  receiverPCs[socketID] = pc;

  pc.onicecandidate = (e) => {
    socket.to(socketID).emit("getSenderCandidate", {
      candidate: e.candidate,
    });
  };

  pc.ontrack = (e) => {
    if (users[roomID]) {
      if (!isIncluded(users[roomID], socketID)) {
        users[roomID].push({
          id: socketID,
          stream: e.streams[0],
          username,
        });
      } else return;
    } else {
      users[roomID] = [
        {
          id: socketID,
          stream: e.streams[0],
          username,
        },
      ];
    }

    // Emit both id and username when a new user enters
    socket.broadcast.to(roomID).emit("userEnter", {
      id: socketID,
      username,
    });

    console.log(`User ${username} entered room: ${roomID}`);
    console.log("Current users in room:", users[roomID]);
  };

  return pc;
};

const createSenderPeerConnection = (
  receiverSocketID,
  senderSocketID,
  socket,
  roomID,
  username
) => {
  const pc = new wrtc.RTCPeerConnection(pc_config);

  if (!senderPCs[senderSocketID]) {
    senderPCs[senderSocketID] = [];
  }

  senderPCs[senderSocketID].push({ id: receiverSocketID, pc });

  pc.onicecandidate = (e) => {
    socket.to(receiverSocketID).emit("getReceiverCandidate", {
      id: senderSocketID,
      candidate: e.candidate,
    });
  };

  const sendUser = users[roomID].find((user) => user.id === senderSocketID);
  sendUser.stream.getTracks().forEach((track) => {
    pc.addTrack(track, sendUser.stream);
  });

  return pc;
};

const getOtherUsersInRoom = (socketID, roomID) => {
  if (!users[roomID]) return [];

  return users[roomID]
    .filter((user) => user.id !== socketID)
    .map((otherUser) => ({
      id: otherUser.id,
      username: otherUser.username,
    }));
};

const deleteUser = (socketID, roomID) => {
  if (!users[roomID]) return;

  users[roomID] = users[roomID].filter((user) => user.id !== socketID);
  if (users[roomID].length === 0) {
    delete users[roomID];
  }

  delete socketToRoom[socketID];
};

const closeReceiverPC = (socketID) => {
  if (!receiverPCs[socketID]) return;

  receiverPCs[socketID].close();
  delete receiverPCs[socketID];
};

const closeSenderPCs = (socketID) => {
  if (!senderPCs[socketID]) return;

  senderPCs[socketID].forEach((senderPC) => {
    senderPC.pc.close();
    const eachSenderPC = senderPCs[senderPC.id].filter(
      (sPC) => sPC.id === socketID
    )[0];
    if (!eachSenderPC) return;
    eachSenderPC.pc.close();
    senderPCs[senderPC.id] = senderPCs[senderPC.id].filter(
      (sPC) => sPC.id !== socketID
    );
  });

  delete senderPCs[socketID];
};

const io = socketio.listen(server);

io.sockets.on("connection", (socket) => {
  socket.on("joinRoom", (data) => {
    try {
      socketToRoom[socket.id] = { roomID: data.roomID, username: data.username };

      let allUsers = getOtherUsersInRoom(socket.id, data.roomID);

      // Send initial room join confirmation with username
      socket.emit("joinedRoom", {
        id: socket.id,
        username: data.username,
        roomID: data.roomID,
      });

      // Make sure usernames are included in allUsers
      io.to(socket.id).emit("allUsers", {
        users: allUsers,
      });

      socket.join(data.roomID);
      console.log(`User ${data.username} joined room: ${data.roomID}`);
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("senderOffer", async (data) => {
    try {
      socketToRoom[data.senderSocketID] = data.roomID;
      let pc = createReceiverPeerConnection(
        data.senderSocketID,
        socket,
        data.roomID,
        data.username
      );
      await pc.setRemoteDescription(data.sdp);
      let sdp = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(sdp);
      socket.join(data.roomID);
      io.to(data.senderSocketID).emit("getSenderAnswer", { sdp });
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("senderCandidate", async (data) => {
    try {
      let pc = receiverPCs[data.senderSocketID];
      await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("receiverOffer", async (data) => {
    try {
      let pc = createSenderPeerConnection(
        data.receiverSocketID,
        data.senderSocketID,
        socket,
        data.roomID,
        data.username
      );
      await pc.setRemoteDescription(data.sdp);
      let sdp = await pc.createAnswer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(sdp);
      io.to(data.receiverSocketID).emit("getReceiverAnswer", {
        id: data.senderSocketID,
        sdp,
      });
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("receiverCandidate", async (data) => {
    try {
      const senderPC = senderPCs[data.senderSocketID].find(
        (sPC) => sPC.id === data.receiverSocketID
      );
      await senderPC.pc.addIceCandidate(
        new wrtc.RTCIceCandidate(data.candidate)
      );
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("disconnect", () => {
    try {
      const roomID = socketToRoom[socket.id]?.roomID;

      deleteUser(socket.id, roomID);
      closeReceiverPC(socket.id);
      closeSenderPCs(socket.id);

      socket.broadcast.to(roomID).emit("userExit", { id: socket.id });
    } catch (error) {
      console.log("error",error);
    }
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("server running on 8080");
});
