FROM node:10

WORKDIR /root/server

# Create data directories if needed
RUN mkdir -p /root/.dockervol/.qtum
RUN mkdir -p /root/.dockervol/.bodhi

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY ./package*.json ./

# If you are building your code for production: RUN npm install --only=production
# Install all packages and specific bodhi-ui version 
RUN npm install bodhi-ui@1.0.4-mainnet

# Bundle app source
COPY . .

# Expose ports for UI and API
EXPOSE 3000 8989

# Run server
CMD [ "npm", "run", "mainnet:prod" ]