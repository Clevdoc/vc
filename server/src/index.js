let http = require("http");
let express = require("express");
let cors = require("cors");
let socketio = require("socket.io");
let wrtc = require("wrtc");

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "*",  // In production, you should specify your frontend domain
  methods: ["GET", "POST"]
}));

let receiverPCs = {};
let senderPCs = {};
let users = {}; // roomID -> [{ id, stream, username }]
let socketToRoom = {}; // socketID -> { roomID, username }

const pc_config = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};

app.get("/get",(req,res)=>{
  res.send("Hello World");
})

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
    console.log(`[${roomID}] Received track for user ${username} (${socketID})`);
    
    const userStream = {
      id: socketID,
      stream: e.streams[0],
      username
    };

    if (users[roomID]) {
      // Remove any existing entries for this user
      users[roomID] = users[roomID].filter(user => user.id !== socketID);
      users[roomID].push(userStream);
    } else {
      users[roomID] = [userStream];
    }
    
    console.log(`[${roomID}] Room state after track:`, 
      JSON.stringify(users[roomID].map(u => ({id: u.id, username: u.username}))));

    socket.broadcast.to(roomID).emit("userEnter", {
      id: socketID,
      username,
    });
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

  // Find the sender's stream
  const sendUser = users[roomID]?.find((user) => user.id === senderSocketID);
  
  if (sendUser?.stream) {
    console.log(`[${roomID}] Adding tracks for user ${username} (${senderSocketID})`);
    try {
      sendUser.stream.getTracks().forEach((track) => {
        pc.addTrack(track, sendUser.stream);
      });
    } catch (error) {
      console.error(`[${roomID}] Error adding tracks:`, error);
    }
  } else {
    console.warn(`[${roomID}] No stream found for user ${username} (${senderSocketID})`);
  }

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

const io = socketio(server, {
  cors: {
    origin: "*", // In production, specify your frontend domain
    methods: ["GET", "POST"],
    credentials: true
  }
});

io.sockets.on("connection", (socket) => {
  socket.on("senderOffer", async (data) => {
    try {
      const senderSocketID = data.senderSocketID || socket.id;  // Fallback to socket.id if not provided
      console.log(`[${data.roomID}] Received sender offer from ${data.username} (${senderSocketID})`);
      
      let pc = createReceiverPeerConnection(
        senderSocketID,
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
      io.to(senderSocketID).emit("getSenderAnswer", { sdp });
    } catch (error) {
      console.error(`[${data?.roomID}] Error in senderOffer:`, error);
    }
  });

  socket.on("receiverOffer", async (data) => {
    try {
      const { senderSocketID, receiverSocketID, roomID, username } = data;
      console.log(`[${roomID}] Received receiver offer from ${username} (${receiverSocketID}) to ${senderSocketID}`);
      
      let pc = createSenderPeerConnection(
        receiverSocketID,
        senderSocketID,
        socket,
        roomID,
        username
      );
      
      await pc.setRemoteDescription(data.sdp);
      let sdp = await pc.createAnswer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(sdp);
      
      io.to(receiverSocketID).emit("getReceiverAnswer", {
        id: senderSocketID,
        sdp,
      });
    } catch (error) {
      console.error(`[${data?.roomID}] Error in receiverOffer:`, error);
    }
  });

  socket.on("joinRoom", async (data) => {
    try {
      const { roomID, username } = data;
      
      console.log(`[${roomID}] Socket ${socket.id} attempting to join as ${username}`);
      
      // Store socket mapping immediately
      socketToRoom[socket.id] = { roomID, username };
      
      // Join the room
      socket.join(roomID);
      
      // Initialize room if needed
      if (!users[roomID]) {
        users[roomID] = [];
      }
      
      // Remove any existing entries for this user
      users[roomID] = users[roomID].filter(user => 
        user.id && user.id !== socket.id && user.username !== username
      );
      
      // Add user to room
      const newUser = {
        id: socket.id,
        username: username,
        stream: null // Stream will be added when tracks are received
      };
      users[roomID].push(newUser);
      
      // Get existing users (excluding the current user)
      let allUsers = users[roomID]
        .filter(user => user.id && user.id !== socket.id)
        .map(user => ({
          id: user.id,
          username: user.username
        }));
      
      console.log(`[${roomID}] Room state:`, 
        JSON.stringify(users[roomID].map(u => ({id: u.id, username: u.username}))));
      
      // Send join confirmation to the user
      socket.emit("joinedRoom", {
        id: socket.id,
        username: username,
        roomID: roomID,
      });

      // Send existing users to the new user
      socket.emit("allUsers", { users: allUsers });
      
      // Notify others about the new user
      socket.broadcast.to(roomID).emit("userEnter", {
        id: socket.id,
        username: username
      });
      
      console.log(`[${roomID}] Sent existing users to ${username}:`, JSON.stringify(allUsers));
    } catch (error) {
      console.error(`[${data?.roomID}] Error in joinRoom:`, error);
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
      const userInfo = socketToRoom[socket.id];
      if (userInfo) {
        const { roomID, username } = userInfo;
        console.log(`[${roomID}] User ${username} (${socket.id}) disconnected`);
        
        // Remove user from room
        if (users[roomID]) {
          users[roomID] = users[roomID].filter(user => user.id !== socket.id);
        }
        
        // Clean up socket mapping
        delete socketToRoom[socket.id];
        
        // Clean up peer connections
        if (receiverPCs[socket.id]) {
          receiverPCs[socket.id].close();
          delete receiverPCs[socket.id];
        }
        
        if (senderPCs[socket.id]) {
          senderPCs[socket.id].forEach(({ pc }) => pc.close());
          delete senderPCs[socket.id];
        }
        
        // Notify others
        socket.broadcast.to(roomID).emit("userExit", { id: socket.id });
      }
    } catch (error) {
      console.error("Error in disconnect:", error);
    }
  });
});

// Add error handling for the server
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Modify the server.listen call to include better error handling
server.listen(process.env.PORT || 8080, '0.0.0.0', () => {  // Add host binding
  console.log(`Server running on port ${process.env.PORT || 8080}`);
});
