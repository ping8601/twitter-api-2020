const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt-nodejs')
const { User, Reply, Tweet, Like } = require('../models')
const { getUser, imgurFileHandler } = require('../_helpers')

const userController = {
  userLogin: async (req, res, next) => {
    try {
      const { email, password } = req.body
      // 檢查必填欄位
      if (!email.trim() || !password.trim()) {
        return res.json({ status: 'error', message: '所有欄位都是必填！' })
      }

      const user = await User.findOne({ where: { email } })
      // 若找不到該帳號使用者，顯示錯誤訊息
      if (!user) return res.status(401).json({ status: 'error', message: "User doesn't exist!" })
      // 若使用者的權限是admin，則依據角色權限顯示錯誤訊息
      if (user.role === 'admin') return res.status(401).json({ status: 'error', message: '帳號不存在' })
      // 比對密碼是否錯誤
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ status: 'error', message: '密碼錯誤！' })
      }
      // token(效期30天)
      const userData = getUser(req).toJSON()
      delete userData.password
      const token = jwt.sign(userData, process.env.JWT_SECRET, { expiresIn: '30d' })
      return res.status(200).json({
        status: 'success',
        data: {
          token,
          user: userData
        }
      })
    } catch (err) {
      next(err)
    }
  },
  getUser: async (req, res, next) => {
    try {
      const { id } = req.params
      let user = await User.findByPk(id, {
        attributes: ['id', 'name', 'account', 'email', 'avatar', 'cover', 'introduction', 'role'],
        include: [
          Reply, Tweet, Like,
          { model: User, as: 'Followers' },
          { model: User, as: 'Followings' }
        ],
        nest: true
      })
      if (!user) return res.status(404).json({ status: 'error', message: '找不到使用者！' })
      user = user.toJSON()
      user.isFollowed = getUser(req).Followings ? getUser(req).Followings.some(f => f.id === user.id) : null
      return res.json(user)
    } catch (err) {
      next(err)
    }
  },
  getUsers: async (req, res, next) => {
    try {
      const top = Number(req.query.top)
      const currentUser = getUser(req)
      const users = await User.findAll({
        attributes: ['id', 'account', 'name', 'avatar'],
        include: [{ model: User, as: 'Followers' }]
      })
      const result = users
        .map(user => ({
          ...user.toJSON(),
          followerCount: user.Followers.length,
          isFollowed: currentUser.Followings.some(f => f.id === user.id)
        }))
        .sort((a, b) => b.followerCount - a.followerCount)
        .slice(0, top || users.length)
      return res.status(200).json({ status: 'success', data: result })
    } catch (err) {
      next(err)
    }
  },
  postUser: async (req, res, next) => {
    try {
      const { account, name, email, password, checkPassword } = req.body
      if (!account || !name || !email || !password || !checkPassword) return res.status(400).json({ status: 'error', message: '所有欄位都是必填！' })
      if (password !== checkPassword) return res.status(400).json({ status: 'error', message: '密碼與密碼確認不相同！' })

      const user1 = await User.findOne({ where: { email } })
      if (user1) return res.status(400).json({ status: 'error', message: 'email 已重複註冊！' })
      const user2 = await User.findOne({ where: { account } })
      if (user2) return res.status(400).json({ status: 'error', message: 'account 已重複註冊！' })

      let createdUser = await User.create({
        account,
        name,
        email,
        password: bcrypt.hashSync(password)
      })

      createdUser = createdUser.toJSON()
      delete createdUser.password

      return res.status(200).json({ status: 'success', data: createdUser })
    } catch (err) {
      next(err)
    }
  },
  putUserAccount: async (req, res, next) => {
    try {
      const { id } = req.params
      // 未回傳則預設不修改
      const { account, name, email, password, checkPassword } = req.body

      // 確定使用者存在
      const user = await User.findByPk(id)
      if (!user) return res.status(404).json({ status: 'error', message: '找不到使用者！' })

      // 只能更改自己的資料
      if (getUser(req).dataValues.id !== Number(id)) return res.status(401).json({ status: 'error', message: '無權限更改此使用者！' })

      // 檢查account是否與其他使用者重複
      if (account) {
        const accountRepeatedUser = await User.findOne({ where: { account }, raw: true })
        if (accountRepeatedUser && Number(accountRepeatedUser.id) !== Number(id)) return res.status(400).json({ status: 'error', message: 'account與其他使用者重複！' })
      }

      // 檢查email是否與其他使用者重複
      if (email) {
        const emailRepeatedUser = await User.findOne({ where: { email }, raw: true })
        if (emailRepeatedUser && Number(emailRepeatedUser.id) !== Number(id)) return res.status(400).json({ status: 'error', message: 'email與其他使用者重複！' })
      }

      // 若有回傳password，檢查password與checkPassword是否相符
      if (password && password !== checkPassword) return res.status(400).json({ status: 'error', message: '密碼與密碼確認不相同！' })

      let updatedUser = await user.update({
        account: account || user.account,
        name: name || user.name,
        email: email || user.email,
        password: bcrypt.hashSync(password) || user.password
      })

      updatedUser = updatedUser.toJSON()
      delete updatedUser.avatar
      delete updatedUser.cover
      delete updatedUser.password
      delete updatedUser.introduction
      delete updatedUser.role

      return res.status(200).json({ status: 'success', data: updatedUser })
    } catch (err) {
      next(err)
    }
  },
  putUserProfile: async (req, res, next) => {
    try {
      const { id } = req.params
      const { name, introduction } = req.body
      const { files } = req

      if (!name) return res.status(400).json({ status: 'error', message: 'name是必填！' })

      const avatar = files?.avatar ? files.avatar[0] : null
      const cover = files?.cover ? files.cover[0] : null

      // 確定使用者存在
      const user = await User.findByPk(id)
      if (!user) return res.status(404).json({ status: 'error', message: '找不到使用者！' })

      // 只能更改自己的資料
      if (getUser(req).dataValues.id !== Number(id)) return res.status(401).json({ status: 'error', message: '無權限更改此使用者！' })

      // 圖片上傳imgur
      const avatarPath = await imgurFileHandler(avatar)
      const coverPath = await imgurFileHandler(cover)

      let updatedUser = await user.update({
        name,
        avatar: avatarPath,
        cover: coverPath,
        introduction
      })

      updatedUser = updatedUser.toJSON()
      delete updatedUser.password
      delete updatedUser.role

      return res.status(200).json({ status: 'success', data: updatedUser })
    } catch (err) {
      next(err)
    }
  }
}

module.exports = userController
